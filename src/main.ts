import {$} from 'bun'
import fs from 'node:fs'
import path from 'node:path'
import google from '@googleapis/youtube'
import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'
import cliProgress from 'cli-progress'
import sanitizeFilename from 'sanitize-filename'
import {safeParse, parse, SchemaIssues} from 'valibot'
import {
  PlaylistItemSchema,
  VideosListItemSchema,
  YtDlpJsonSchema,
} from './schemas'

export type Video = {
  /** listApi.snippet.resourceId.videoId */
  id: string
  /** listApi.snippet.title */
  title: string
  /** listApi.snippet.description */
  description: string
  /** listApi.snippet.videoOwnerChannelId */
  channelId: string
  /** listApi.snippet.videoOwnerChannelTitle */
  channelName: string
  /** listApi.contentDetails.videoPublishedAt */
  dateCreated: string
  /** listApi.snippet.publishedAt */
  dateAddedToPlaylist: string
  /** listApi.snippet.thumbnails[maxres | standard | high | medium | default].url */
  thumbnailUrls: string[]
  /** videosApi.contentDetails.duration */
  durationInSeconds: number
  /** Constructed from `id` - URL to the video */
  url: string
  /** Constructed from `channelId` - URL to the video owner's channel */
  channelUrl: string | null
  /** Derived from yt-dlp */
  audioFileExtension: string | null
  /** Derived from yt-dlp */
  videoFileExtension: string | null
  /** Derived from the listApi missing certain fields */
  isUnavailable: boolean
}

type PartialVideo = Omit<
  Video,
  'durationInSeconds' | 'audioFileExtension' | 'videoFileExtension'
>

type PartialVideoWithDuration = PartialVideo & Pick<Video, 'durationInSeconds'>

export type DownloadType = 'audio' | 'video' | 'both' | 'none'

export type Failure = {date: number} & (
  | {
      type: 'Bun.write'
      file: string
      error: Record<string, unknown>
    }
  | {
      type: 'schemaParse'
      schemaName:
        | 'PlaylistItemSchema'
        | 'VideosListItemSchema'
        | 'YtDlpJsonSchema'
      issues: SchemaIssues
    }
  | {
      type: 'videosListApi'
      error: Record<string, unknown>
      ids: string[] | undefined
    }
  | {
      type: 'partialVideoNotFound'
      id: string
    }
  | {
      type: 'ytdlpFailure'
      url: string
      template: string
      stderr: string
    }
  | {
      type: 'thumbnailDownload'
      url: string
      status: number
      statusText: string
    }
  | {
      type: 'thumbnailUrlNotAvailable'
      urls: string[]
      videoId: string
    }
)

export type FailureType = Failure['type']

export type FailuresObj = {
  [K in Failure['type']]: Omit<Extract<Failure, {type: K}>, 'type'>[]
}

export type DownloadCount = {audio: number; video: number; thumbnail: number}

export type Results = {
  failureData: FailuresObj
  downloadCount: DownloadCount
  youTubeFetchCount: number
}

export async function downloadYouTubePlaylist({
  playlistId,
  youTubeApiKey,
  directory,
  downloadType,
  audioFormat = 'mp3',
  videoFormat = 'mp4',
  downloadThumbnails = false,
  maxDurationSeconds = Infinity,
  mostRecentItemsCount,
  silent = false,
  maxConcurrentFetchCalls = 4,
  maxConcurrentYtdlpCalls = 10,
  saveRawResponses = false,
}: {
  /** YouTube playlist id. */
  playlistId: string

  /**
   * YouTube API key. This will be used to fetch all metadata for videos in the
   * playlist.
   */
  youTubeApiKey: string

  /**
   * The absolute path to where the data should be stored. Sub-folders will be
   * created as needed. The folder structure will be:
   *
   * - `<directory>/metadata.json` - an array of objects (`Video[]`)
   * - `<directory>/audio` - contains the audio files
   * - `<directory>/video` - contains the video files
   * - `<directory>/thumbnails` - contains the jpg thumbnail files
   */
  directory: string

  /**
   * `'none'`  - No files will be downloaded, including thumbnails. Only the
   *             `metadata.json` file will be written.
   *
   * `'audio'` - Download only audio files as determined by the `audioFormat`
   *             option. Defaults to `'mp3'`.
   *
   * `'video'` - Download only video files as determined by the `videoFormat`
   *             option. Defaults to `'mp4'`
   *
   * `'both'`  - Download audio and video files as determined by their
   *             corresponding format options.
   */
  downloadType: DownloadType

  /**
   * Optional - default value `'mp3'`
   *
   * A valid yt-dlp audio [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  audioFormat?: string

  /**
   * Optional - default value `'mp4'`
   *
   * A valid yt-dlp video [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  videoFormat?: string

  /**
   * Optional - default value `false`
   *
   * A boolean indicating wether to download a `.jpg` thumbnail for each video.
   * The highest resolution available will be downloaded. Only thumbnails for
   * new videos will be downloaded.
   */
  downloadThumbnails?: boolean

  /**
   * Optional - default value `Infinity`
   *
   * The maximum duration in seconds a playlist item can be to be downloaded.
   */
  maxDurationSeconds?: number

  /**
   * Optional - default value `undefined`
   *
   * A _positive_ number indicating how many items in the playlist to retrieve,
   * starting with the most recent. Negative and invalid numbers will be
   * ignored. All items will be retrieved if no value is provided.
   *
   * I.e. `mostRecentItemsCount: 20` will only retrieve data for the most recent
   * 20 videos in the playlist. This option is useful when running in a cron job
   * to avoid fetching and parsing the entire list when you may already have a
   * substantial portion processed and downloaded already.
   */
  mostRecentItemsCount?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating wether to silence all internal console.log's.
   */
  silent?: boolean

  /**
   * Optional - default value `4`
   *
   * The number of concurrent fetch calls made to the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   */
  maxConcurrentFetchCalls?: number

  /**
   * Optional - default value `10`
   *
   * The number of concurrent downloads to process. We use
   * [Bun's shell](https://bun.sh/docs/runtime/shell) to asychronously execute
   * the [yt-dlp](https://github.com/yt-dlp/yt-dlp) command.
   */
  maxConcurrentYtdlpCalls?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating whether to save the response data directly from the
   * YouTube API. This can be helpful for debugging. If set to `true`, two files
   * will be saved:
   *
   * - youtubePlaylistResponses.json
   * - youtubeVideoResponses.json
   */
  saveRawResponses?: boolean
}): Promise<Results> {
  const log = silent ? () => {} : console.log
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

  log('\n👉 Checking system dependencies...')

  const ytDlpPath = Bun.which('yt-dlp')
  const ffmpegPath = Bun.which('ffmpeg')
  directory = path.resolve(directory) // Ensure an absolute directory.
  const directoryExists = fs.existsSync(directory)

  if (ytDlpPath === null) {
    console.error('\nCould not find the `yt-dlp` package on this system.')
    console.error('This package is needed to download YouTube videos.')
    console.error(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )
  }

  if (ffmpegPath === null) {
    console.error('\nCould not find the `ffmpeg` package on this system.')
    console.error(
      'This package is needed to extract audio from YouTube videos.'
    )
    console.error(
      'You can download a binary at https://www.ffmpeg.org/download.html or run `brew install ffmpeg`.'
    )
  }

  if (!directoryExists) {
    console.error(
      `\n${directory} does not exist. Please check the path or create it.`
    )
  }

  if (ytDlpPath === null || ffmpegPath === null || !directoryExists) {
    /**
     * This is the only place we exit the process in `downloadYouTubePlaylist`.
     * All other errors or failures get stored in the `Failures` array and
     * returned to the user upon completion.
     */
    process.exit(1)
  }

  log('✅ `yt-dlp` and `ffmpeg` are present!')

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

  /** The YouTube API client. */
  const yt = google.youtube({version: 'v3', auth: youTubeApiKey})
  const startFetchMetadata = performance.now()
  log(
    `\n👉 Getting partial video metadata for ${
      mostRecentItemsCount || 'all'
    } items...`
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
  const playlistItemsResponses = await genPlaylistItems({
    yt,
    playlistId,
    youTubeFetchCount,
    // Default to Infinity, representing all items.
    totalItemsToFetch: mostRecentItemsCount || Infinity,
  })

  if (saveRawResponses) {
    try {
      await Bun.write(
        `${directory}/youtubePlaylistResponses.json`,
        JSON.stringify(playlistItemsResponses, null, 2)
      )
    } catch (error) {
      failures.push({
        type: 'Bun.write',
        file: 'youtubePlaylistResponses.json',
        error: errorToObject(error),
        date: Date.now(),
      })
    }
  }

  /**
   * A flattened and massaged list of metadata for videos based on the initial
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * call. This metadata lacks file extensions and certain properties only
   * returned from the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * API call later on.
   */
  const partialVideosMetadata: PartialVideo[] = playlistItemsResponses.reduce<
    PartialVideo[]
  >((acc, response) => {
    response.data.items?.forEach(item => {
      const isUnavailable =
        item.snippet?.title === 'Private video' ||
        item.snippet?.title === 'Deleted video'
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

        acc.push({
          id: snippet.resourceId.videoId,
          title: sanitizeTitle(snippet.title),
          description: snippet.description,
          channelId: snippet.videoOwnerChannelId,
          channelName: snippet.videoOwnerChannelTitle,
          dateCreated: contentDetails.videoPublishedAt,
          dateAddedToPlaylist: snippet.publishedAt,

          /**
           * Somethings YouTube returns a 404 response for these urls. We store
           * multiple urls in highest quality descending order so that when we
           * go to download a thumbnail we get the best available version.
           */
          thumbnailUrls: [
            snippet.thumbnails.maxres?.url,
            snippet.thumbnails.standard?.url,
            snippet.thumbnails.high?.url,
            snippet.thumbnails.medium?.url,
            snippet.thumbnails.default?.url,
          ].filter(v => typeof v === 'string'),
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
   * metadata lacks file extensions and certain properties only returned from
   * the
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
   * will give us, filter out unavailble videos to potentially reduce how many
   * fetch calls are made the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * coming up and add missing metadata to unavailable videos.
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
        })
      } else {
        acc.videoIdsToFetch.push(partialVideo.id)
      }

      return acc
    },
    {videoIdsToFetch: [], unavailableVideos: []}
  )

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

  log(
    `👉 Getting remaining video metadata for ${pluralize(
      videoIdsToFetch.length,
      'item'
    )}...`
  )

  /**
   * Since the YouTube APIs can retrieve up to 50 items in a single fetch call,
   * create an array of id arrays that are 50 ids each:
   *
   * [[50 ids], [50 ids], ...]
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
   */
  const fetchIdChunks = chunkArray(
    chunkedVideoIdsToFetch,
    maxConcurrentFetchCalls
  )

  /**
   * Raw responses from the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   * This gets the remaining metadata for each video.
   */
  const videosListResponses = await fetchIdChunks.reduce<
    Promise<
      (GaxiosResponse<google.youtube_v3.Schema$VideoListResponse> | null)[]
    >
  >((promise, idArrays) => {
    return promise.then(previousResults =>
      Promise.allSettled(
        // `idArrays` represents how many concurrent promises we want to run.
        idArrays.map(ids => {
          youTubeFetchCount.count++
          return yt.videos.list({id: ids, part: ['contentDetails']})
        })
      ).then(results => {
        const successfullResults: (GaxiosResponse<google.youtube_v3.Schema$VideoListResponse> | null)[] =
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
            successfullResults.push(null)
          }
        })

        return previousResults.concat(successfullResults)
      })
    )
  }, Promise.resolve([]))

  if (saveRawResponses) {
    try {
      await Bun.write(
        `${directory}/youtubeVideoResponses.json`,
        JSON.stringify(videosListResponses, null, 2)
      )
    } catch (error) {
      failures.push({
        type: 'Bun.write',
        file: 'youtubeVideoResponses.json',
        error: errorToObject(error),
        date: Date.now(),
      })
    }
  }

  /**
   * Construct an object of formatted durations for each video from the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * call.
   */
  const durationsObj = videosListResponses.reduce<Record<string, number>>(
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

  /**
   * Combines all the metadata we have from the
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
   * and
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * calls.
   */
  const partialVideosWithDurationMetadata: PartialVideoWithDuration[] =
    partialVideosMetadata.map(partialVideo => {
      const durationInSeconds = durationsObj[partialVideo.id] ?? 0
      return {...partialVideo, durationInSeconds}
    })

  const fetchMetadataTime = sanitizeTime(performance.now() - startFetchMetadata)
  log(`✅ Video metadata received! [${fetchMetadataTime}]`)

  /**
   * *********
   * STEP 3: *
   * *********
   * Determine which videos need to be downloaded.
   *
   * We compare our metadata to what we have on disk. Any available videos found
   * in the response data that are not found on disk are downloaded. If the
   * expected directories don't exist they will be created in a later step when
   * we save the videos.
   */

  // 💡 Directories may not exist - they will be created at a later step.
  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`
  const {existingAudioFilesObj, existingVideoFilesObj} =
    getExistingFilesObj(directory)

  /**
   * Filter the metadata from the YouTube APIs to determine which videos we will
   * actually download. A download will happen if:
   * - The video doesn't exist on the file system already
   * - The video isn't longer than `maxDurationSeconds`
   * - The video is available according to the YouTube APIs
   */
  const potentialVideosToDownload = partialVideosWithDurationMetadata.filter(
    ({id, durationInSeconds, isUnavailable}) => {
      return (
        // The download type isn't 'none'...
        // downloadType !== 'none' &&
        // The video isn't too long...
        durationInSeconds <= maxDurationSeconds &&
        // The video isn't unavailable...
        !isUnavailable &&
        // The video hasn't already been downloaded...
        (!existingAudioFilesObj[id] || !existingVideoFilesObj[id])
      )
    }
  )

  /**
   * *********
   * STEP 4: *
   * *********
   * Download the videos.
   *
   * We will create the directories needed conditionally.
   */

  // Create audio dir.
  if (downloadType === 'audio' || downloadType === 'both') {
    mkdirSafe(audioDir)
  }

  // Create video dir.
  if (downloadType === 'video' || downloadType === 'both') {
    mkdirSafe(videoDir)
  }

  const startProcessing = performance.now()
  const makeTemplate = (title: string, type: 'audio' | 'video') => {
    return `${directory}/${type}/${title} [%(id)s].%(ext)s`
  }
  const videoProgressBar = new cliProgress.SingleBar(
    {
      format: '👉 {bar} {percentage}% | {value}/{total} | {duration_formatted}',
      // barsize: Math.round(process.stdout.columns * 0.75),
      stopOnComplete: true,
    },
    cliProgress.Presets.shades_grey
  )

  const downloadCount: DownloadCount = {audio: 0, video: 0, thumbnail: 0}

  /**
   * This contains the promise functions for the different download types. File
   * extensions are retrieved from yt-dlp's json and added to the metadata.
   */
  const downloadPromiseFxns = potentialVideosToDownload.reduce<
    (() => Promise<Video | null>)[]
  >((acc, partialVideoWithDuration) => {
    const {id, title, url} = partialVideoWithDuration
    const audioExistsOnDisk = !!existingAudioFilesObj[id]
    const videoExistsOnDisk = !!existingVideoFilesObj[id]
    const audioTemplate = makeTemplate(title, 'audio')
    const videoTemplate = makeTemplate(title, 'video')

    const bothPromiseFxn = () => {
      return $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" --extract-audio --audio-format="${audioFormat}" -k -J --no-simulate ${url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          videoProgressBar.increment()

          if (exitCode !== 0) {
            failures.push({
              type: 'ytdlpFailure',
              url,
              template: `yt-dlp -o "${videoTemplate}" --format="${videoFormat}" --extract-audio --audio-format="${audioFormat}" -k -J --no-simulate ${url}`,
              stderr: stderr.toString(),
              date: Date.now(),
            })

            return null
          }

          /**
           * We use a single `yt-dlp` command to download both so both can be
           * safely incremented at the same time.
           */
          downloadCount.audio++
          downloadCount.video++

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

          const {ext: videoFileExtension, requested_downloads} =
            parsedResults.output
          const audioFileExtension = requested_downloads[0]!.ext
          const oldAudioPath = `${videoDir}/${title} [${id}].${audioFileExtension}`
          const newAudioPath = `${audioDir}/${title} [${id}].${audioFileExtension}`

          fs.renameSync(oldAudioPath, newAudioPath)

          return {
            ...partialVideoWithDuration,
            audioFileExtension,
            videoFileExtension,
          }
        })
    }

    const videoPromiseFxn = () => {
      return $`yt-dlp -o "${videoTemplate}" --format="${videoFormat}" -J --no-simulate ${url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          videoProgressBar.increment()

          if (exitCode !== 0) {
            failures.push({
              type: 'ytdlpFailure',
              url,
              template: `yt-dlp -o "${videoTemplate}" --format="${videoFormat}" -J --no-simulate ${url}`,
              stderr: stderr.toString(),
              date: Date.now(),
            })

            return null
          }

          downloadCount.video++

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

          const {ext: videoFileExtension} = parsedResults.output

          return {
            ...partialVideoWithDuration,
            audioFileExtension: null,
            videoFileExtension,
          }
        })
    }

    const audioPromiseFxn = () => {
      return $`yt-dlp -o "${audioTemplate}" --extract-audio --audio-format="${audioFormat}" -J --no-simulate ${url}`
        .quiet()
        .then(({exitCode, stdout, stderr}) => {
          videoProgressBar.increment()

          if (exitCode !== 0) {
            failures.push({
              type: 'ytdlpFailure',
              url,
              template: `yt-dlp -o "${audioTemplate}" --extract-audio --audio-format="${audioFormat}" -J --no-simulate ${url}`,
              stderr: stderr.toString(),
              date: Date.now(),
            })

            return null
          }

          downloadCount.audio++

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

          const {requested_downloads} = parsedResults.output

          return {
            ...partialVideoWithDuration,
            audioFileExtension: requested_downloads[0]!.ext,
            videoFileExtension: null,
          }
        })
    }

    const nonePromiseFxn = () => {
      videoProgressBar.increment()

      return Promise.resolve({
        ...partialVideoWithDuration,
        audioFileExtension: null,
        videoFileExtension: null,
      })
    }

    if (downloadType === 'both') {
      if (audioExistsOnDisk && !videoExistsOnDisk) {
        acc.push(videoPromiseFxn)
      }

      if (!audioExistsOnDisk && videoExistsOnDisk) {
        acc.push(audioPromiseFxn)
      }

      if (!audioExistsOnDisk && !videoExistsOnDisk) {
        acc.push(bothPromiseFxn)
      }
    }

    if (downloadType === 'video' && !videoExistsOnDisk) {
      acc.push(videoPromiseFxn)
    }

    if (downloadType === 'audio' && !audioExistsOnDisk) {
      acc.push(audioPromiseFxn)
    }

    if (downloadType === 'none') {
      acc.push(nonePromiseFxn)
    }

    return acc
  }, [])

  const downloadVerb = downloadType === 'none' ? 'Processing' : 'Downloading'

  if (downloadPromiseFxns.length) {
    log(
      `\n👉 ${downloadVerb} ${pluralize(
        downloadPromiseFxns.length,
        'playlist item'
      )}...`
    )

    if (!silent) {
      videoProgressBar.start(downloadPromiseFxns.length, 0)
    }
  } else if (downloadType !== 'none') {
    log('\n✅ All videos accounted for, nothing to download!')
  }

  const promiseFxnBatches = chunkArray(
    downloadPromiseFxns,
    maxConcurrentYtdlpCalls
  )

  /**
   * The actual download! `freshMetadata` as in full Video metadata from all the
   * recent YouTube API calls. Successful downloads will end up in
   * `freshMetadata` while failed downloads will wind up in the failures data.
   */
  const freshMetadata = await promiseFxnBatches.reduce<Promise<Video[]>>(
    (promise, promiseFxnBatch) => {
      return promise.then(previousResults => {
        return Promise.allSettled(promiseFxnBatch.map(fxn => fxn())).then(
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

  videoProgressBar.stop()

  if (downloadPromiseFxns.length) {
    const processingTime = sanitizeTime(performance.now() - startProcessing)
    const {icon, errorMessage} = getErrorCountIconAndMessage(
      failures,
      failure => {
        return (
          failure.type === 'ytdlpFailure' ||
          (failure.type === 'schemaParse' &&
            failure.schemaName === 'YtDlpJsonSchema')
        )
      }
    )

    log(`${icon} ${downloadVerb} complete!${errorMessage} [${processingTime}]`)
  }

  /**
   * *********
   * STEP 5: *
   * *********
   * Download the thumbnails.
   *
   * The thumbnails directory will be created if not present.
   */
  if (downloadThumbnails) {
    // Create the thumbnail directory if it doesn't exist.
    const thumbnailDirectory = `${directory}/thumbnails`
    mkdirSafe(thumbnailDirectory)

    const existingThumbnailIdsOnDiskSet = fs
      .readdirSync(thumbnailDirectory)
      .reduce<Set<string>>((set, item) => {
        // Remove file extension, adding the thumbnail id to the set.
        if (item.endsWith('.jpg')) {
          set.add(item.slice(0, -4))
        }

        return set
      }, new Set())

    /**
     * An array of objects containing a video id and an array of thumbnail urls.
     * The array of thumbnail urls are in quality order, descending. Sometimes
     * YouTube will return a 404 response for urls it previously gave use from
     * the API calls. The array of thumbnail urls ensures we can find the
     * highest quality thumbnail available.
     */
    const thumbnailsToDownload = potentialVideosToDownload.reduce<
      {urls: string[]; id: string}[]
    >((acc, video) => {
      const {thumbnailUrls, id} = video

      if (!existingThumbnailIdsOnDiskSet.has(id) && thumbnailUrls.length) {
        acc.push({urls: thumbnailUrls, id})
      }

      return acc
    }, [])

    const thumbnailsLength = thumbnailsToDownload.length

    if (thumbnailsLength) {
      const thumbnailProgressBar = new cliProgress.SingleBar(
        {
          format:
            '👉 {bar} {percentage}% | {value}/{total} | {duration_formatted}',
          // barsize: Math.round(process.stdout.columns * 0.75),
          stopOnComplete: true,
        },
        cliProgress.Presets.shades_grey
      )

      log(`\n👉 Downloading ${pluralize(thumbnailsLength, 'thumbnail')}...`)
      if (!silent) {
        thumbnailProgressBar.start(thumbnailsLength, 0)
      }

      const thumbnailPromiseBatches = chunkArray(
        thumbnailsToDownload,
        maxConcurrentFetchCalls
      )
      const startThumbnails = performance.now()

      await thumbnailPromiseBatches.reduce<Promise<void>>((promise, batch) => {
        return promise
          .then(() => {
            return Promise.all(
              batch.map(({urls, id}) => {
                return downloadThumbnailFile({
                  urls,
                  id,
                  thumbnailDirectory,
                })
                  .then(() => {
                    downloadCount.thumbnail++
                  })
                  .catch((failure: Failure) => {
                    failures.push(failure)
                  })
                  .finally(() => {
                    thumbnailProgressBar.increment()
                  })
              })
            )
          })
          .then(() => {})
      }, Promise.resolve())
      thumbnailProgressBar.stop()

      const {icon, errorMessage} = getErrorCountIconAndMessage(
        failures,
        ({type}) =>
          type === 'thumbnailDownload' || type === 'thumbnailUrlNotAvailable'
      )

      log(
        `${icon} Thumbnails downloaded!${errorMessage} [${sanitizeTime(
          performance.now() - startThumbnails
        )}]`
      )
    } else {
      log('\n✅ All thumbnails accounted for, nothing to download!')
    }
  }

  /**
   * *********
   * STEP 6: *
   * *********
   * Update `metadata.json`
   */

  const metadataJsonPath = `${directory}/metadata.json`
  const existingMetadata: Video[] = await Bun.file(metadataJsonPath)
    .json()
    .catch(() => []) // In case the file doesn't exist yet.
  const isMetadataJsonMissing = existingMetadata.length === 0
  const shouldWriteMetadata = !!freshMetadata.length || isMetadataJsonMissing

  if (shouldWriteMetadata) {
    log('\n👉 Updating metadata.json...')

    let metadataItemsUpdated = 0
    const startUpdateMetadata = performance.now()

    /**
     * An object version of the current `metadata.json` file on disk. This
     * object is intended to be updated with any new video data we have.
     */
    const existingMetadataObj = existingMetadata.reduce<Record<string, Video>>(
      (acc, video) => {
        acc[video.id] = video
        return acc
      },
      {}
    )

    /**
     * In the case that downloads happened, this represents all the metadata for
     * the new downloads.
     *
     * In the case that downloads didn't happen AND the `metadata.json` file is
     * missing, this represents metadata gathered from analyzing what files are
     * currently on the file system.
     */
    const videoMetadataToWrite: Video[] = (() => {
      if (freshMetadata.length) return freshMetadata

      /**
       * If we're missing the `metadata.json` file, `downloadType` is 'audio'
       * or 'video', AND all the files are on the system already,
       * `freshMetadata` will have no length because it's based on the
       * `downloadPromiseFxns` array. Promise functions are skipped from being
       * added to that array if we detect the file is already on the system,
       * thereby giving us an empty array, so we can't rely on its length to
       * gauge which downloads happened.
       *
       * Therefore, if we're missing the `metadata.json` file AND there are no
       * files to download, we need to rely on `potentialVideosToDownload` which
       * has the metadata we want to write. Usually the promise functions will
       * return that metadata after downloading a file, but in this case we
       * didn't download anything and so we need to look elsewhere for the
       * metadata.
       */
      if (isMetadataJsonMissing) {
        return potentialVideosToDownload.map(partialVideoWithDuration => {
          const {id} = partialVideoWithDuration
          const existingAudio = existingAudioFilesObj[id]
          const existingVideo = existingVideoFilesObj[id]

          // Get the file extension from existing audio and video files.
          const audioFileExtension = existingAudio
            ? path.parse(existingAudio).ext.slice(1)
            : null
          const videoFileExtension = existingVideo
            ? path.parse(existingVideo).ext.slice(1)
            : null

          return {
            ...partialVideoWithDuration,
            audioFileExtension,
            videoFileExtension,
          }
        })
      }

      return []
    })()

    /**
     * The Videos List API won't return any data for unavailable videos. We
     * explicitly concat them here so they can be included in the metadata.
     * The final list will be sorted by `dateAddedToPlaylist`.
     */
    const totalMetadata = videoMetadataToWrite.concat(unavailableVideos)

    /**
     * Here we update our metadata to prepare for writing the file. There are a
     * few scenarios we're accounting for:
     * - Unavailable => available (replace with new video)
     * - Available => unavailable (update existing video)
     * - File extension change
     */
    totalMetadata.forEach(video => {
      const existingVideo = existingMetadataObj[video.id]

      if (existingVideo) {
        if (existingVideo.isUnavailable && !video.isUnavailable) {
          // Unavailable => available (replace with new video)
          existingMetadataObj[video.id] = video
          metadataItemsUpdated++
        } else if (!existingVideo.isUnavailable && video.isUnavailable) {
          // Available => unavailable (update existing video)
          existingVideo.isUnavailable = true
          metadataItemsUpdated++
        } else if (!existingVideo.isUnavailable && !video.isUnavailable) {
          // Capture the original extensions first for comparison later.
          const existingAudioExt = existingVideo.audioFileExtension
          const existingVideoExt = existingVideo.videoFileExtension

          /**
           * The video exists on disk AND in the new metadata from the YouTube
           * APIs - most likely a file extension change.
           */
          existingVideo.audioFileExtension =
            video.audioFileExtension ?? existingVideo.audioFileExtension
          existingVideo.videoFileExtension =
            video.videoFileExtension ?? existingVideo.videoFileExtension

          if (
            existingAudioExt !== existingVideo.audioFileExtension ||
            existingVideoExt !== existingVideo.videoFileExtension
          ) {
            metadataItemsUpdated++
          }
        }
      } else {
        // New video.
        existingMetadataObj[video.id] = video
        metadataItemsUpdated++
      }
    })

    if (metadataItemsUpdated) {
      const sortedMetadata = Object.values(existingMetadataObj).sort((a, b) => {
        return (
          +new Date(b.dateAddedToPlaylist) - +new Date(a.dateAddedToPlaylist)
        )
      })

      try {
        await Bun.write(
          metadataJsonPath,
          JSON.stringify(sortedMetadata, null, 2)
        )

        log(
          `✅ Updated ${pluralize(
            metadataItemsUpdated,
            'metadata item'
          )}! [${sanitizeTime(performance.now() - startUpdateMetadata)}]`
        )
      } catch (error) {
        failures.push({
          type: 'Bun.write',
          file: metadataJsonPath,
          error: errorToObject(error),
          date: Date.now(),
        })

        log(`❌ Unable to write file: ${metadataJsonPath}`)
      }
    } else {
      log('✅ metadata.json already up to date!')
    }
  }

  log(
    `\n🚀 Process complete! [${sanitizeTime(performance.now() - processStart)}]`
  )

  const failureData = failures.reduce<FailuresObj>(
    (acc, {type, ...rest}) => {
      // @ts-expect-error `rest` is the appropriate type.
      acc[type].push(rest)
      return acc
    },
    {
      'Bun.write': [],
      schemaParse: [],
      videosListApi: [],
      partialVideoNotFound: [],
      ytdlpFailure: [],
      thumbnailDownload: [],
      thumbnailUrlNotAvailable: [],
    }
  )

  return {
    youTubeFetchCount: youTubeFetchCount.count,
    downloadCount,
    failureData,
  }
}

/**
 * This function tries to create a directory. If it already exists, an error
 * will be thrown. This function prevents that error from being thrown.
 */
function mkdirSafe(dir: string) {
  try {
    fs.mkdirSync(dir)
  } catch {}
}

/**
 * Converts a number of milliseconds into a plain-english string, such as
 * "4 minutes 32 seconds"
 */
function sanitizeTime(ms: number): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = sanitizeDecimal(totalSeconds % 60)
  const secondsFinalValue = pluralize(seconds, 'second')

  return minutes
    ? `${pluralize(minutes, 'minute')} ${secondsFinalValue}`
    : secondsFinalValue
}

/**
 * Massages a float into consistent decimal format as a string. Examples:
 * - 2.1091 => 2.11
 * - 2.0    => 2
 * - 2.10   => 2.1
 * - 2.0    => 2
 */
function sanitizeDecimal(num: number): string {
  return (
    num
      .toFixed(2)
      /**
       * `(\.\d*?)` - captures the decimal point `\.` followed by zero or more
       *              digits `\d*`, but it does so non-greedily due to the `?`
       *              after the `*`. This means it captures the smallest possible
       *              sequence of digits after the decimal point. This part is
       *              enclosed in parentheses to create a capturing group. The
       *              captured content will be referred to as `$1` in the
       *              replacement string.
       * `0*$`      - This part matches zero or more zeros `0*` that appear at the
       *              end of the string `$`.
       * `'$1'`     - Refers to the content captured by the first capturing group.
       */
      .replace(/(\.\d*?)0*$/, '$1')
      /**
       * `\.$`      - Remove any trailing period that might be present after the
       *              zeros are removed. It matches a period at the end of the
       *              string and replaces it with an empty string.
       */
      .replace(/\.$/, '')
  )
}

/**
 * pluralize(3, 'apple') => '3 apples'
 * pluralize(0, 'apple') => '0 apples'
 * pluralize(1, 'apple') =? '1 apple'
 */
function pluralize(amount: number | string, word: string): string {
  const s = +amount === 1 ? '' : 's'
  return `${amount} ${word}${s}`
}

/**
 * Uses the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
 * to fetch metadata on videos.
 *
 * This function intentionally doesn't massage the API responses and leaves that
 * responsibility up to consumers for cleaner, more predictable code.
 */
async function genPlaylistItems({
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
    itemsLeftToFetch > 0 && itemsLeftToFetch <= 50 ? itemsLeftToFetch : 50

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

function parseISO8601DurationToSeconds(durationString: string) {
  const regex =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/

  const matches = durationString.match(regex) ?? []
  const years = matches[1] ? parseInt(matches[1]) : 0
  const months = matches[2] ? parseInt(matches[2]) : 0
  const weeks = matches[3] ? parseInt(matches[3]) : 0
  const days = matches[4] ? parseInt(matches[4]) : 0
  const hours = matches[5] ? parseInt(matches[5]) : 0
  const minutes = matches[6] ? parseInt(matches[6]) : 0
  const seconds = matches[7] ? parseFloat(matches[7]) : 0
  const totalSeconds =
    years * 31536000 +
    months * 2592000 +
    weeks * 604800 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds

  return totalSeconds
}

/**
 * Fetches a thumbnail url and writes the contents to a file. If the fetch or
 * file write fails, a `Failure` is thrown.
 */
async function downloadThumbnailFile({
  urls,
  id,
  thumbnailDirectory,
}: {
  urls: string[]
  id: string
  thumbnailDirectory: string
}): Promise<undefined> {
  return _downloadThumbnailFile({urls, id, thumbnailDirectory, index: 0})
}

/**
 * Internal counterpart to `downloadThumbnailFile`. This function calls itself
 * recursively.
 */
async function _downloadThumbnailFile({
  urls,
  id,
  thumbnailDirectory,
  index,
  redirectedUrl,
}: {
  urls: string[]
  id: string
  thumbnailDirectory: string
  index: number
  redirectedUrl?: string
}): Promise<undefined> {
  if (index >= urls.length) {
    const failure: Failure = {
      type: 'thumbnailUrlNotAvailable',
      urls,
      videoId: id,
      date: Date.now(),
    }

    throw failure
  }

  // We know we have a string based on the check above.
  const url = redirectedUrl ?? urls[index]!

  return fetch(url, {
    method: 'GET',
    headers: {'Content-Type': 'image/jpg'},
    redirect: 'follow',
  }).then(async res => {
    // 400s - try with the next url in the list.
    if (res.status >= 400 && res.status <= 499) {
      return _downloadThumbnailFile({
        urls,
        id,
        thumbnailDirectory,
        index: index + 1,
      })
    }

    // 300s - retry with the redirected url.
    if (res.status >= 300 && res.status <= 399) {
      return _downloadThumbnailFile({
        urls,
        id,
        thumbnailDirectory,
        index,
        redirectedUrl: res.url,
      })
    }

    if (!res.ok) {
      const failure: Failure = {
        type: 'thumbnailDownload',
        url,
        status: res.status,
        statusText: res.statusText,
        date: Date.now(),
      }

      throw failure
    }

    try {
      await Bun.write(`${thumbnailDirectory}/${id}.jpg`, res)
    } catch (error) {
      const failure: Failure = {
        type: 'Bun.write',
        file: `${thumbnailDirectory}/${id}.jpg`,
        error: errorToObject(error),
        date: Date.now(),
      }

      throw failure
    }
  })
}

/**
 * This regex pattern matches a square bracket followed by one or more
 * alphanumeric characters or the special characters `-` and `_`, followed
 * by a closing square bracket. The .\w+$ part matches the file extension
 * and ensures that the match is at the end of the file name.
 *
 * Here's a step-by-step explanation of the regex pattern:
 * 1. `\[` - Matches a literal opening square bracket
 * 2. `(` - Starts a capturing group
 * 3. `[a-zA-Z0-9_-]` - Matches any alphanumeric character or the special characters `-` and `_`
 * 4. `+` - Matches one or more of the preceding characters
 * 5. `)` - Ends the capturing group
 * 6. `\]` - Matches a literal closing square bracket
 * 7. `\.` - Matches a literal dot
 * 8. `\w+` - Matches one or more word characters (i.e., the file extension)
 * 9. `$` - Matches the end of the string
 *
 * Thanks to perplexity.ai for generating this regex!
 */
export const squareBracketIdRegex = /\[([a-zA-Z0-9_-]+)\]\.\w+$/

const MAX_YOUTUBE_RESULTS = 50

function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}

function sanitizeTitle(str: string): string {
  const safeTitle = sanitizeFilename(str, {replacement: ' '})

  // Use a regular expression to replace consecutive spaces with a single space.
  return safeTitle.replace(/\s+/g, ' ')
}

export type FileStatCategoryInfo = {
  totalSize: number
  files: {file: string; id: string}[]
  extensionSet: Set<string>
}

export type FileStat = {
  type: string
  fileCount: number
  extensions: string
  totalSize: string
}

function bytesToSize(bytes: number): string {
  if (bytes >= 1073741824) {
    return sanitizeDecimal(bytes / 1073741824) + ' GB'
  } else if (bytes >= 1048576) {
    return sanitizeDecimal(bytes / 1048576) + ' MB'
  } else if (bytes >= 1024) {
    return sanitizeDecimal(bytes / 1024) + ' KB'
  } else if (bytes > 1) {
    return bytes + ' bytes'
  } else if (bytes == 1) {
    return bytes + ' byte'
  } else {
    return '0 bytes'
  }
}

function errorToObject(error: any): Record<string, unknown> {
  return Object.getOwnPropertyNames(error).reduce<Record<string, any>>(
    (acc, key) => {
      acc[key] = error[key]
      return acc
    },
    {}
  )
}

function getErrorCountIconAndMessage(
  failures: Failure[],
  conditionFxn: (failure: Failure) => boolean
): {icon: '💡' | '✅'; errorMessage: string} {
  const errorCount = failures.reduce<number>((count, failure) => {
    if (conditionFxn(failure)) count++
    return count
  }, 0)
  // The leading space is intentional.
  const errorMessage = errorCount ? ` ${pluralize(errorCount, 'error')}` : ''
  const icon = errorCount ? '💡' : '✅'

  return {icon, errorMessage}
}

async function genVideosObjFromJson(directory: string) {
  const videoData: Video[] = await Bun.file(`${directory}/metadata.json`).json()

  return videoData.reduce<Record<string, Video>>((acc, video) => {
    acc[video.id] = video
    return acc
  }, {})
}

function getFileStats(directory: string): FileStat[] {
  const {audioData, videoData, thumbnailData} = [
    `${directory}/audio`,
    `${directory}/video`,
    `${directory}/thumbnails`,
  ].reduce<{
    audioData: FileStatCategoryInfo
    videoData: FileStatCategoryInfo
    thumbnailData: FileStatCategoryInfo
  }>(
    (acc, dir) => {
      if (!fs.existsSync(dir)) return acc

      fs.readdirSync(dir).forEach(file => {
        const id = file.match(squareBracketIdRegex)?.[1]
        const bunFile = Bun.file(`${dir}/${file}`)
        const type = bunFile.type.split('/')[0] // audio/mpeg => audio
        const extension = path.parse(file).ext.replace('.', '')

        if (id) {
          if (type === 'audio') {
            acc.audioData.files.push({file, id})
            acc.audioData.totalSize += bunFile.size
            acc.audioData.extensionSet.add(extension)
          }

          if (type === 'video') {
            acc.videoData.files.push({file, id})
            acc.videoData.totalSize += bunFile.size
            acc.videoData.extensionSet.add(extension)
          }
        }

        if (type === 'image') {
          acc.thumbnailData.files.push({file, id: file.slice(0, -4)})
          acc.thumbnailData.totalSize += bunFile.size
          acc.thumbnailData.extensionSet.add(extension)
        }
      }, [])

      return acc
    },
    {
      thumbnailData: {totalSize: 0, files: [], extensionSet: new Set()},
      audioData: {totalSize: 0, files: [], extensionSet: new Set()},
      videoData: {totalSize: 0, files: [], extensionSet: new Set()},
    }
  )

  return [
    {
      type: 'audio',
      totalSize: audioData.totalSize,
      fileCount: audioData.files.length,
      extensions: [...audioData.extensionSet].join(', '),
    },
    {
      type: 'video',
      totalSize: videoData.totalSize,
      fileCount: videoData.files.length,
      extensions: [...videoData.extensionSet].join(', '),
    },
    {
      type: 'thumbnail',
      totalSize: thumbnailData.totalSize,
      fileCount: thumbnailData.files.length,
      extensions: [...thumbnailData.extensionSet].join(', '),
    },
  ]
    .sort((a, b) => {
      return b.totalSize - a.totalSize
    })
    .reduce<FileStat[]>((acc, {totalSize, ...rest}) => {
      if (totalSize) {
        acc.push({...rest, totalSize: bytesToSize(totalSize)})
      }

      return acc
    }, [])
}

async function genMetadataStats(directory: string) {
  const metadataJson: Video[] = await Bun.file(
    `${directory}/metadata.json`
  ).json()
  const metadataJsonObj = metadataJson.reduce<Record<string, Video>>(
    (acc, video) => {
      acc[video.id] = video
      return acc
    },
    {}
  )
  const {existingAudioFilesObj, existingVideoFilesObj} =
    getExistingFilesObj(directory)
  const thumbnailIdsOnDiskSet: Set<string> = (() => {
    const set = new Set<string>()

    try {
      fs.readdirSync(`${directory}/thumbnails`).forEach(fileName => {
        if (fileName.endsWith('.jpg')) {
          // '123.jpg' => '123'
          set.add(fileName.slice(0, -4))
        }
      })
    } catch {
      // noop
    }

    return set
  })()
  const itemsTotal = metadataJson.length
  const {
    itemsUnavailable,
    itemsAvailable,
    itemsMissingFileOnDisk,
    itemsMissingThumbnailOnDisk,
  } = metadataJson.reduce<{
    itemsUnavailable: number
    itemsAvailable: number
    itemsMissingFileOnDisk: Video[]
    itemsMissingThumbnailOnDisk: Video[]
  }>(
    (acc, video) => {
      acc[video.isUnavailable ? 'itemsUnavailable' : 'itemsAvailable']++

      const audioFile = existingAudioFilesObj[video.id]
      const videoFile = existingVideoFilesObj[video.id]

      if (!audioFile && !videoFile) {
        acc.itemsMissingFileOnDisk.push(video)
      }

      if (!thumbnailIdsOnDiskSet.has(video.id)) {
        acc.itemsMissingThumbnailOnDisk.push(video)
      }

      return acc
    },
    {
      itemsUnavailable: 0,
      itemsAvailable: 0,
      itemsMissingFileOnDisk: [],
      itemsMissingThumbnailOnDisk: [],
    }
  )

  const audioFilesWithoutMetadata = Object.keys(existingAudioFilesObj).filter(
    id => !metadataJsonObj[id]
  )
  const videoFilesWithoutMetadata = Object.keys(existingVideoFilesObj).filter(
    id => !metadataJsonObj[id]
  )

  return {
    itemsTotal,
    itemsUnavailable,
    itemsAvailable,
    itemsMissingFileOnDisk,
    itemsMissingFileOnDiskCount: itemsMissingFileOnDisk.length,
    itemsMissingThumbnailOnDisk,
    itemsMissingThumbnailOnDiskCount: itemsMissingThumbnailOnDisk.length,
    audioFilesWithoutMetadata,
    videoFilesWithoutMetadata,
  }
}

export async function genStats(directory: string) {
  const fileStats = getFileStats(directory)
  const metadataStats = await genMetadataStats(directory)

  return {fileStats, metadataStats}
}

/**
 * Returns an object of the shape {[videoId]: fileName }
 */
function getExistingFilesObj(directory: string) {
  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`

  const [existingAudioFilesObj, existingVideoFilesObj] = [
    audioDir,
    videoDir,
  ].map(dir => {
    try {
      return fs
        .readdirSync(dir)
        .reduce<Record<string, string>>((acc, fileName) => {
          const id = fileName.match(squareBracketIdRegex)?.[1]
          if (id) acc[id] = fileName

          return acc
        }, {})
    } catch {
      // The directory doesn't exist yet.
      return {}
    }
  }) as [Record<string, string>, Record<string, string>]

  return {existingAudioFilesObj, existingVideoFilesObj}
}

export async function downloadVideo({
  url,
  directory,
  downloadType = 'video',
  format,
  overwrite = false,
}: {
  /** YouTube video URL. */
  url: string

  /** Absolute path where the downloaded video should be saved. */
  directory: string

  /**
   * Optional - defaults to `'video'`
   *
   * Options are `'audio'` or `'video'`.
   */
  downloadType?: 'video' | 'audio'

  /**
   * Optional - defaults to `'mp4'` for video and `'mp3'` for audio.
   *
   * A valid yt-dlp video or audio
   * [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection)
   * corresponding to `downloadType`.
   */
  format?: string

  /**
   * Optional - default `false`
   *
   * Overwrites files if they already exist.
   */
  overwrite?: boolean
}): Promise<{
  id: string
  title: string
  description: string
  durationInSeconds: number
  url: string
  channelId: string
  channelName: string
  channelUrl: string
  dateCreated: string | null
}> {
  const fileFormat = format ?? (downloadType === 'audio' ? 'mp3' : 'mp4')
  const start = performance.now()

  console.log(`👉 Downloading ${downloadType}...`)

  /**
   * *********
   * STEP 1: *
   * *********
   * Get the metadata for the YouTube video.
   */

  const videoInfoResponse = await $`yt-dlp -J ${url}`.quiet()
  const {title: rawTitle} = parse(
    YtDlpJsonSchema,
    JSON.parse(videoInfoResponse.stdout.toString())
  )
  const title = sanitizeTitle(rawTitle)

  /**
   * *********
   * STEP 2: *
   * *********
   * Determine if the video already exists on the file system.
   */

  // Determine if we have already downloaded the video before.
  const {audioExists, videoExists} = fs
    .readdirSync(directory)
    .reduce<{audioExists: boolean; videoExists: boolean}>(
      (acc, item) => {
        const id = item.match(squareBracketIdRegex)?.[1]

        if (id) {
          const type = Bun.file(`${directory}/${item}`).type.split('/')[0]

          if (type === 'audio') acc.audioExists = true
          if (type === 'video') acc.videoExists = true
        }

        return acc
      },
      {audioExists: false, videoExists: false}
    )

  /**
   * *********
   * STEP 3: *
   * *********
   * Download the video.
   */

  const downloadFileResponse = await (() => {
    const template = `${directory}/${title} [%(id)s].%(ext)s`

    if (downloadType === 'audio') {
      if (audioExists && !overwrite) {
        console.log(
          '🚫 File already exists. To overwrite, pass `overwrite: true`.'
        )
        process.exit()
      }

      return $`yt-dlp -o "${template}" --extract-audio --audio-format="${fileFormat}" -J --no-simulate ${url}`.quiet()
    }

    if (videoExists && !overwrite) {
      console.log(
        '🚫 File already exists. To overwrite, pass `overwrite: true`.'
      )
      process.exit()
    }

    return $`yt-dlp -o "${template}" --format="${fileFormat}" -J --no-simulate ${url}`.quiet()
  })()

  if (downloadFileResponse.exitCode !== 0) {
    console.error(downloadFileResponse.stderr.toString())
    process.exit(downloadFileResponse.exitCode)
  }

  const {
    id,
    description,
    duration: durationInSeconds,
    channel_id: channelId,
    channel: channelName,
    channel_url: channelUrl,
    upload_date, // e.x. '20240221' (i.e. 2/21/2024)
  } = parse(YtDlpJsonSchema, JSON.parse(downloadFileResponse.stdout.toString()))

  const time = performance.now() - start
  console.log(`✅ Download complete! [${sanitizeTime(time)}]`)

  const dateCreated: string | null = (() => {
    const year = Number(upload_date.slice(0, 4))
    const month = Number(upload_date.slice(4, 6)) - 1 // Months are 0-index
    const day = Number(upload_date.slice(-2))
    const date = new Date(year, month, day)

    return date.toString() === 'Invalid Date' ? null : date.toISOString()
  })()

  return {
    id,
    title,
    description,
    durationInSeconds,
    url,
    channelId,
    channelName,
    channelUrl,
    dateCreated,
  }
}
