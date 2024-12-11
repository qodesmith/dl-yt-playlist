import type {
  DownloadCount,
  DownloadYouTubePlaylistInput,
  DownloadYouTubePlaylistOutput,
  Failure,
  PartialVideo,
  PartialVideoWithDuration,
  Video,
} from './types'
import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

import fs from 'node:fs'

import google from '@googleapis/youtube'
import {chunkArray, createLogger, emptyLog, pluralize} from '@qodestack/utils'
import {$} from 'bun'
import cliProgress from 'cli-progress'
import {safeParse} from 'valibot'

import {
  PlaylistItemSchema,
  VideosListItemSchema,
  YtDlpJsonSchema,
} from './schemas'
import {
  downloadThumbnailFile,
  getLufsForFile,
  mkdirSafe,
  parseISO8601DurationToSeconds,
  sanitizeTime,
} from './utils'

const MAX_YOUTUBE_RESULTS = 50

export async function downloadYouTubePlaylist(
  options: DownloadYouTubePlaylistInput
): Promise<DownloadYouTubePlaylistOutput> {
  const {
    // Required options.
    playlistId,
    youTubeApiKey,
    downloadType,

    // Optional options.
    maxDurationSeconds = Infinity,
    mostRecentItemsCount,
    silent = false,
    timeZone,
    maxConcurrentYouTubeCalls = 4,
    maxConcurrentYtdlpCalls = 10,
  } = options

  const log = createLogger({timeZone})
  const logger = silent ? emptyLog : log
  const processStart = performance.now()

  /**
   * Instead of exiting the process when something fails, we store metadata
   * about the failures and continue the process. Failures are then returned
   * to the user for further action.
   */
  const failures: Failure[] = []

  /**
   * *********
   * STEP 1: *
   * *********
   * Check for system dependencies.
   *
   * yt-dlp is the package we use to download videos from a YouTube playlist.
   * ffmpeg is the package that yt-dlp uses under the hood to convert videos to
   * audio files. Check for both of these before proceeding and provide a
   * helpful message if any are missing. The process will exit with an error
   * without returning anything if dependencies are missing.
   */

  logger.text('Checking for yt-dlp and ffmpeg...')

  const ytDlpPath = Bun.which('yt-dlp')
  const ffmpegPath = Bun.which('ffmpeg')

  if (ytDlpPath === null) {
    logger.error('\nCould not find the `yt-dlp` package on this system.')
    logger.error('This package is needed to download YouTube videos.')
    logger.error(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )
  }

  if (ffmpegPath === null) {
    logger.error('\nCould not find the `ffmpeg` package on this system.')
    logger.error('This package is needed to extract audio from YouTube videos.')
    logger.error(
      'You can download a binary at https://www.ffmpeg.org/download.html or run `brew install ffmpeg`.'
    )
  }

  if (!ytDlpPath || !ffmpegPath) {
    /**
     * This is the only place we exit the process in `downloadYouTubePlaylist`.
     * All other errors or failures get stored in the `Failures` array and
     * returned to the user upon completion.
     */
    throw new Error('Missing `yt-dlp` or `ffmpeg`')
  }

  logger.text('`yt-dlp` and `ffmpeg` are present!')

  /**
   * *********
   * STEP 2: *
   * *********
   * Get metadata for each video.
   *
   * See comments on the `Video` type for where each field comes from in the
   * YouTube API. Depending on the input variables we will either fetch the
   * entire playlist or the most recent specified number of videos. This is
   * helpful when running in a cron job where we don't need to fetch the entire
   * playlist each time.
   */

  // The YouTube API client.
  const yt = google.youtube({version: 'v3', auth: youTubeApiKey})
  const startYouTubeCalls = performance.now()

  logger.text(
    `Getting partial video metadata for ${
      mostRecentItemsCount !== undefined
        ? pluralize(mostRecentItemsCount, 'item')
        : 'all items'
    }...`
  )

  /**
   * This object stores how many times the YouTube APIs are called throughout
   * the entire process. This is helpful to gauge against quotas.
   */
  const youTubeFetchCount = {count: 0}

  /**
   * Raw responses from the YouTube
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * getting playlist-level metadata for each video (this includes most of the
   * metadata we'll need).
   */
  const playlistItemListResponses = await genPlaylistItems({
    yt,
    playlistId,
    youTubeFetchCount,
    // Default to Infinity, representing all items.
    totalItemsToFetch: mostRecentItemsCount || Infinity,
  }).catch(error => {
    failures.push({
      type: 'generic',
      error,
      date: Date.now(),
      context: 'genPlaylistItems',
    })

    return []
  })

  /**
   * A flattened and massaged list of metadata for videos based on the initial
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * call. This metadata lacks file extensions and certain properties only
   * returned from the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * API call later on.
   */
  const partialVideosMetadata: PartialVideo[] =
    playlistItemListResponses.reduce<PartialVideo[]>((acc, response) => {
      response.data.items?.forEach(item => {
        const results = safeParse(PlaylistItemSchema, item)

        if (!results.success) {
          failures.push({
            type: 'schemaParse',
            schemaName: 'PlaylistItemSchema',
            issues: results.issues,
            date: Date.now(),
          })
        } else {
          const {snippet, contentDetails} = results.output
          const isUnavailable =
            snippet.title === 'Private video' ||
            snippet.title === 'Deleted video'

          acc.push({
            id: snippet.resourceId.videoId,
            playlistItemId: results.output.id,
            title: snippet.title,
            description: snippet.description,
            channelId: snippet.videoOwnerChannelId,
            channelName: snippet.videoOwnerChannelTitle,
            dateCreated: contentDetails.videoPublishedAt,
            dateAddedToPlaylist: snippet.publishedAt,

            /**
             * Sometimes YouTube returns a 404 response for these urls. We store
             * multiple urls in highest quality descending order so that when we
             * go to download a thumbnail we get the best available version.
             */
            thumbnailUrls: [
              snippet.thumbnails.maxres?.url,
              snippet.thumbnails.standard?.url,
              snippet.thumbnails.high?.url,
              snippet.thumbnails.medium?.url,
              snippet.thumbnails.default?.url,
            ].filter(Boolean) as string[],
            url: `https://www.youtube.com/watch?v=${snippet.resourceId.videoId}`,
            channelUrl: `https://www.youtube.com/channel/${snippet.videoOwnerChannelId}`,
            isUnavailable,
          })
        }
      })

      return acc
    }, [])

  /**
   * An object version of a flattened and massaged list of metadata for videos,
   * based on the initial
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * call, so we can directly access a partial video object by its id. This
   * metadata lacks file extensions and certain properties only returned by the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * API call later on.
   */
  const partialVideosMetadataObj = partialVideosMetadata.reduce<
    Record<string, PartialVideo>
  >((acc, partialVideo) => {
    acc[partialVideo.id] = partialVideo
    return acc
  }, {})

  /**
   * Now that we've retrieved everything the
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * will give us, separate the unavailable videos from available videos. For
   * unavailable videos, we add the missing metadata to make them adhere to the
   * `Video` type. For available videos, we need their ids which will be used
   * by the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * coming up to fetch the rest of their metadata.
   */
  const partialVideoReductionData = partialVideosMetadata.reduce<{
    videoIdsToFetch: string[]
    unavailableVideos: Video[]
  }>(
    (acc, partialVideo) => {
      if (partialVideo.isUnavailable) {
        acc.unavailableVideos.push({
          ...partialVideo,
          durationInSeconds: 0,
          audioFileExtension: null,
          videoFileExtension: null,
          lufs: null,
        })
      } else {
        acc.videoIdsToFetch.push(partialVideo.id)
      }

      return acc
    },
    {videoIdsToFetch: [], unavailableVideos: []}
  )

  // Creating separate variables with comments for intellisense when hovering.

  /**
   * Unavailable videos from the recent call to the
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems).
   */
  const unavailableVideos = partialVideoReductionData.unavailableVideos

  /**
   * Ids for all the available videos from the
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * call.
   */
  const videoIdsToFetch = partialVideoReductionData.videoIdsToFetch

  logger.text(
    `Getting remaining video metadata for ${pluralize(
      videoIdsToFetch.length,
      'item'
    )}...`
  )

  /**
   * Since the YouTube APIs can retrieve up to 50 items in a single fetch call,
   * create an array of id arrays that are 50 ids each:
   *
   * ```
   * [[50 ids], [50 ids], ...]
   * ```
   */
  const chunkedVideoIdsToFetch = chunkArray(
    videoIdsToFetch,
    MAX_YOUTUBE_RESULTS
  )

  /**
   * A single call to the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * can specify a max of 50 ids. We want to run a number of concurrent fetch
   * calls, so further chunk the array.
   *
   * For example, 4 max concurrent calls would create this 3D array:
   *
   * ```
   * [
   *   [[50 ids], [50 ids], [50 ids], [50 ids]],
   *   [[50 ids], [50 ids], [50 ids], [50 ids]],
   *   ...
   * ]
   * ```
   */
  const fetchIdChunks = chunkArray(
    chunkedVideoIdsToFetch,
    maxConcurrentYouTubeCalls
  )

  /**
   * Raw responses from the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   * This gets the remaining metadata for each video.
   */
  const videoListResponses = await fetchIdChunks
    .reduce<
      Promise<(GaxiosResponse<youtube_v3.Schema$VideoListResponse> | null)[]>
    >((promise, idArrays) => {
      return promise.then(previousResults =>
        Promise.allSettled(
          // `idArrays` represents how many concurrent promises we want to run.
          idArrays.map(ids => {
            youTubeFetchCount.count++
            return yt.videos.list({id: ids, part: ['contentDetails']})
          })
        ).then(results => {
          const successfullResults: (GaxiosResponse<youtube_v3.Schema$VideoListResponse> | null)[] =
            []

          results.forEach((response, resultIndex) => {
            if (response.status === 'fulfilled') {
              successfullResults.push(response.value)
            } else {
              failures.push({
                type: 'videosListApi',
                error: response.reason,
                ids: idArrays[resultIndex],
                date: Date.now(),
              })

              /**
               * We store a null value to maintain the correct array index for the
               * API call.
               */
              successfullResults.push(null)
            }
          })

          return previousResults.concat(successfullResults)
        })
      )
    }, Promise.resolve([]))
    .catch(error => {
      failures.push({
        type: 'generic',
        error,
        date: Date.now(),
        context: 'fetchIdChunks.reduce',
      })

      return []
    })

  /**
   * Construct an object of formatted durations for each video from the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * call. This will be used to add duration data to the final metadata.
   */
  const durationsObj = videoListResponses.reduce<Record<string, number>>(
    (acc, response) => {
      response?.data.items?.forEach(item => {
        const parsedResults = safeParse(VideosListItemSchema, item)

        if (!parsedResults.success) {
          failures.push({
            type: 'schemaParse',
            schemaName: 'VideosListItemSchema',
            issues: parsedResults.issues,
            date: Date.now(),
          })

          return
        }

        const {id, contentDetails} = parsedResults.output
        const duration = contentDetails.duration
        const partialVideo = partialVideosMetadataObj[id]

        if (!partialVideo) {
          failures.push({type: 'partialVideoNotFound', id, date: Date.now()})
        } else {
          acc[id] = parseISO8601DurationToSeconds(duration)
        }
      })

      return acc
    },
    {}
  )

  // Add duration times to the partial metadata we have so far.
  const partialVideosWithDurationMetadata: PartialVideoWithDuration[] =
    partialVideosMetadata.map(partialVideo => {
      const durationInSeconds = durationsObj[partialVideo.id] ?? 0
      return {...partialVideo, durationInSeconds}
    })

  // An obj with all the video metadata we have so far for reference later.
  const partialVideosWthDurationObj = partialVideosWithDurationMetadata.reduce<
    Record<string, PartialVideo & {durationInSeconds: number}>
  >((acc, {durationInSeconds, ...partialVideo}) => {
    acc[partialVideo.id] = {...partialVideo, durationInSeconds}
    return acc
  }, {})

  const fetchMetadataTime = sanitizeTime(performance.now() - startYouTubeCalls)
  logger.text(`Video metadata received! [${fetchMetadataTime}]`)

  /**
   * *********
   * STEP 3: *
   * *********
   * Determine which videos need to be downloaded.
   *
   * We compare our metadata to what we have in the system. We want to avoid
   * using the files in `directory` as the source of truth since a database
   * might be involved on the user's end. We keep the source of truth agnostic
   * by having the user provide a `getIdsForDownload` function that filters out
   * which ids to download, leaving that logic up to the user. Ids returned from
   * that function represent videos to download.
   */

  const idsToDownload = await (async () => {
    if (downloadType === 'none') return []

    /**
     * Filter the metadata from the YouTube APIs to determine which videos we
     * will potentially download:
     * - The video isn't longer than `maxDurationSeconds`
     * - The video is available according to the YouTube APIs
     */
    const potentialIds = partialVideosWithDurationMetadata.reduce<string[]>(
      (acc, {id, durationInSeconds, isUnavailable}) => {
        if (durationInSeconds <= maxDurationSeconds && !isUnavailable) {
          acc.push(id)
        }

        return acc
      },
      []
    )

    /**
     * Determine which videos we will actually download. Logic is left up to the
     * consumer. For example, a consumer may check if the file is on disk or if
     * a database already has an entry for a given id. `getIdsForDownload` will
     * determine which ids out of the batch should be downloaded.
     */
    return await Promise.resolve(options.getIdsForDownload(potentialIds)).catch(
      error => {
        failures.push({
          type: 'generic',
          error,
          date: Date.now(),
          context: 'getIdsForDownload',
        })

        return []
      }
    )
  })()

  /**
   * *********
   * STEP 4: *
   * *********
   * Download the videos.
   *
   * We will create the directories needed conditionally.
   */

  const downloadCount: DownloadCount = {audio: 0, video: 0, thumbnail: 0}

  if (downloadType === 'none') {
    logger.success(
      `Process complete! [${sanitizeTime(performance.now() - processStart)}]`
    )

    return {
      playlistItemListResponses,
      videoListResponses,
      videosDownloaded: [],
      unavailableVideos,
      failures,
      downloadCount,
      youTubeFetchCount: youTubeFetchCount.count,
    }
  }

  const {directory, downloadThumbnails} = options
  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`
  const thumbnailDirectory = `${directory}/thumbnails`

  // Create audio directory.
  if (downloadType === 'audio' || downloadType === 'both') {
    mkdirSafe(audioDir)
  }

  // Create video directory.
  if (downloadType === 'video' || downloadType === 'both') {
    mkdirSafe(videoDir)
  }

  // Create thumnails directory.
  if (downloadThumbnails) {
    mkdirSafe(thumbnailDirectory)
  }

  const startProcessing = performance.now()
  const downloadProgressBar = new cliProgress.SingleBar(
    {
      format: '👉 {bar} {percentage}% | {value}/{total} | {duration_formatted}',
      // barsize: Math.round(process.stdout.columns * 0.75),
      stopOnComplete: true,
    },
    cliProgress.Presets.shades_grey
  )

  const audioTemplate = `${directory}/audio/%(id)s.%(ext)s`
  const videoTemplate = `${directory}/video/%(id)s.%(ext)s`

  const downloadPromiseFxns: (() => Promise<Video | null>)[] = (
    idsToDownload ?? []
  ).map(id => {
    return async () => {
      const partialVideo = partialVideosWthDurationObj[id]

      if (!partialVideo) {
        failures.push({type: 'partialVideoNotFound', id, date: Date.now()})
        return null
      }

      if (downloadThumbnails) {
        await downloadThumbnailFile({
          urls: partialVideo.thumbnailUrls,
          id,
          thumbnailDirectory,
        })
          .then(() => {
            downloadCount.thumbnail++
          })
          .catch((failure: Failure) => {
            failures.push(failure)
          })
      }

      const {url} = partialVideo
      const {shellPromise, template} = (() => {
        if (downloadType === 'audio') {
          const {audioFormat} = options

          return {
            shellPromise: $`yt-dlp -o "${audioTemplate}" --extract-audio --audio-format="${audioFormat}" -J --no-simulate ${url}`,
            template: `yt-dlp -o "${audioTemplate}" --extract-audio --audio-format="${audioFormat}" -J --no-simulate ${url}`,
          }
        }

        if (downloadType === 'video') {
          const {videoFormat} = options

          return {
            shellPromise: $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" -J --no-simulate ${url}`,
            template: `yt-dlp -o "${videoTemplate}" --format="${videoFormat}" -J --no-simulate ${url}`,
          }
        }

        const {audioFormat, videoFormat} = options

        return {
          shellPromise: $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" --extract-audio --audio-format="${audioFormat}" -k -J --no-simulate ${url}`,
          template: `yt-dlp -o "${videoTemplate}" --format="${videoFormat}" --extract-audio --audio-format="${audioFormat}" -k -J --no-simulate ${url}`,
        }
      })()

      return shellPromise
        .nothrow() // Necessary to ensure `.then` is populated with `exitCode`.
        .quiet() // Avoid printing to stdout.
        .then(({exitCode, stdout, stderr}) => {
          downloadProgressBar.increment()

          if (exitCode !== 0) {
            failures.push({
              type: 'ytdlpFailure',
              url,
              template,
              stderr: stderr.toString(),
              date: Date.now(),
            })

            return null
          }

          if (downloadType === 'audio' || downloadType === 'both') {
            downloadCount.audio++
          }

          if (downloadType === 'video' || downloadType === 'both') {
            downloadCount.video++
          }

          const parsedResults = safeParse(
            YtDlpJsonSchema,
            JSON.parse(stdout.toString())
          )

          if (!parsedResults.success) {
            failures.push({
              type: 'schemaParse',
              schemaName: 'YtDlpJsonSchema',
              issues: parsedResults.issues,
              date: Date.now(),
            })

            return null
          }

          const {ext, requested_downloads} = parsedResults.output
          const audioFileExtension = requested_downloads[0]?.ext
          const audioFilePath = `${audioDir}/${id}.${audioFileExtension}`
          const videoFilePath = `${videoDir}/${id}.${ext}`

          if (downloadType === 'both') {
            /**
             * The ytdlp template will download the video and audio files into the
             * video directory. We manually move the audio file here.
             */
            const currentAudioPath = `${videoDir}/${id}.${audioFileExtension}`
            fs.renameSync(currentAudioPath, audioFilePath)
          }

          const lufsFilePath =
            downloadType === 'video' ? videoFilePath : audioFilePath
          const lufs = getLufsForFile(lufsFilePath)
          const isLufsValid = typeof lufs === 'number'

          if (!isLufsValid) {
            failures.push({
              type: 'lufs',
              filePath: lufsFilePath,
              errorMessage: lufs.error,
              date: Date.now(),
            })
          }

          return {
            ...partialVideo,
            audioFileExtension: audioFileExtension ?? null,
            videoFileExtension: downloadType === 'audio' ? null : ext,
            lufs: isLufsValid ? lufs : null,
          }
        })
        .catch(error => {
          failures.push({
            type: 'generic',
            error,
            date: Date.now(),
            context: `downloadPromiseFxns => shellPromise => id - ${id}`,
          })

          return null
        })
    }
  })

  if (!downloadPromiseFxns.length) {
    logger.text('All videos accounted for, nothing to download!')
    logger.success(
      `Process complete! [${sanitizeTime(performance.now() - processStart)}]`
    )

    return {
      playlistItemListResponses,
      videoListResponses,
      videosDownloaded: [],
      unavailableVideos,
      failures,
      downloadCount,
      youTubeFetchCount: youTubeFetchCount.count,
    }
  }

  logger.text(
    `Downloading ${pluralize(downloadPromiseFxns.length, 'playlist item')}...`
  )

  if (!silent) {
    downloadProgressBar.start(downloadPromiseFxns.length, 0)
  }

  const promiseFxnBatches = chunkArray(
    downloadPromiseFxns,
    maxConcurrentYtdlpCalls
  )

  // The actual download!
  const videosDownloaded = await promiseFxnBatches.reduce<Promise<Video[]>>(
    (promise, promiseFxnBatch) => {
      return promise.then(previousResults => {
        return Promise.allSettled(promiseFxnBatch.map(f => f())).then(
          newResults => {
            const successfulResults: Video[] = []

            newResults.forEach(response => {
              // Errors already handled in the promise functions above.
              if (response.status === 'fulfilled' && response.value !== null) {
                successfulResults.push(response.value)
              }
            })

            return previousResults.concat(successfulResults)
          }
        )
      })
    },
    Promise.resolve([])
  )

  downloadProgressBar.stop()

  const processingTime = sanitizeTime(performance.now() - startProcessing)
  logger.text(`Downloading complete! [${processingTime}]`)

  logger.success(
    `Process complete! [${sanitizeTime(performance.now() - processStart)}]`
  )

  return {
    playlistItemListResponses,
    videoListResponses,
    videosDownloaded,
    unavailableVideos,
    failures,
    downloadCount,
    youTubeFetchCount: youTubeFetchCount.count,
  }
}

/**
 * Uses the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
 * to fetch metadata on videos.
 *
 * This function intentionally doesn't massage the API responses and leaves that
 * responsibility up to consumers for cleaner, more predictable code.
 */
export async function genPlaylistItems({
  yt,
  playlistId,
  youTubeFetchCount,
  totalItemsToFetch,
}: {
  /** The YouTube API class used to make the fetch calls. */
  yt: youtube_v3.Youtube

  /** Playlist id. */
  playlistId: string

  /** A counter to track how many fetch calls are made. */
  youTubeFetchCount: {count: number}

  /** Maximum number of videos to fetch from the API. */
  totalItemsToFetch: number
}): Promise<
  GaxiosResponse<google.youtube_v3.Schema$PlaylistItemListResponse>[]
> {
  return _genPlaylistItems({
    yt,
    playlistId,
    youTubeFetchCount,
    totalItemsToFetch,

    /**
     * These values are meant to kick off the process. They will be updated in
     * recursive calls.
     */
    itemsFetchedCount: 0,
    pageToken: undefined,
    responses: [],
  })
}

/**
 * Internal counterpart to `genPlaylistItems`. This function calls itself
 * recursively.
 */
async function _genPlaylistItems({
  yt,
  playlistId,
  youTubeFetchCount,
  totalItemsToFetch,
  itemsFetchedCount,
  pageToken,
  responses,
}: {
  /** The YouTube API class used to make the fetch calls. */
  yt: youtube_v3.Youtube

  /** Playlist id. */
  playlistId: string

  /** A counter to track how many fetch calls are made. */
  youTubeFetchCount: {count: number}

  /** Maximum number of videos to fetch from the API. */
  totalItemsToFetch: number

  /**
   * Each response from the API will have a list of items. These are the
   * individual video metadata objects. We specifiy how many of these we want
   * via `totalItemsToFetch`. This number represents how many have been fetched
   * so far.
   */
  itemsFetchedCount: number

  /**
   * A value returned by the API indicating there are more results to be
   * fetched.
   */
  pageToken: string | undefined

  /**
   * Will be provided in resursive calls. An array retaining all API responses.
   */
  responses: Awaited<
    GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  >[]
}): Promise<
  GaxiosResponse<google.youtube_v3.Schema$PlaylistItemListResponse>[]
> {
  const itemsLeftToFetch = totalItemsToFetch - itemsFetchedCount
  const maxResults =
    itemsLeftToFetch > 0 && itemsLeftToFetch <= MAX_YOUTUBE_RESULTS
      ? itemsLeftToFetch
      : MAX_YOUTUBE_RESULTS

  const response = await yt.playlistItems.list({
    playlistId,
    part: ['contentDetails', 'snippet'],
    maxResults,
    pageToken,
  })

  youTubeFetchCount.count++

  const {nextPageToken, items} = response.data
  const updatededResponses = responses.concat(response)
  const newItemsFetchedCount = itemsFetchedCount + (items?.length ?? 0)
  const shouldContinueFetching = totalItemsToFetch - newItemsFetchedCount > 0

  if (nextPageToken && shouldContinueFetching) {
    return _genPlaylistItems({
      yt,
      playlistId,
      youTubeFetchCount,
      totalItemsToFetch,
      itemsFetchedCount: newItemsFetchedCount,
      pageToken: nextPageToken,
      responses: updatededResponses,
    })
  }

  return updatededResponses
}
