import {$, ShellOutput} from 'bun'
import fs from 'node:fs'
import path from 'node:path'
import google from '@googleapis/youtube'
import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'
import cliProgress from 'cli-progress'
import sanitizeFilename from 'sanitize-filename'
import {
  safeParse,
  object,
  string,
  optional,
  array,
  minLength,
  SchemaIssues,
} from 'valibot'

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
  thumbnailUrl: string | null
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
      error: unknown
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
      error: unknown
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
      type: 'downloadThumbnail'
      status: number
      statusText: string
    }
)

export type FailuresObj = Record<Failure['type'], Omit<Failure, 'type'>[]>

export type DownloadCount = {audio: number; video: number; thumbnail: number}

export type Results = {
  failureData: FailuresObj
  downloadCount: DownloadCount
  youTubeFetchCount: number
}

/**
 * This schema is used to parse the response from the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems).
 * Optional properties are marked as so to accommodate videos no longer
 * available.
 */
const PlaylistItemSchema = object({
  snippet: object({
    resourceId: object({
      videoId: string(), // id
    }),
    title: string(),
    description: string(),
    videoOwnerChannelId: optional(string(), ''), // channelId
    videoOwnerChannelTitle: optional(string(), ''), // channelName
    publishedAt: string(), // dateAddedToPlaylist

    // thumbnailUrl
    thumbnails: object({
      maxres: optional(object({url: string()})),
      standard: optional(object({url: string()})),
      high: optional(object({url: string()})),
      medium: optional(object({url: string()})),
      default: optional(object({url: string()})),
    }),
  }),
  contentDetails: object({
    videoPublishedAt: optional(string(), ''), // dateCreated
  }),
})

const VideosListItemSchema = object({
  id: string(),
  contentDetails: object({
    duration: string(),
  }),
})

const YtDlpJsonSchema = object({
  ext: string(), // Video file extension.
  requested_downloads: array(
    object({
      ext: string(), // Audio file extension.
    }),
    [minLength(1)]
  ),
})

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
      '\n Could not find the directory provided. Please check the path or create it.'
    )
  }

  if (ytDlpPath === null || ffmpegPath === null || !directoryExists) {
    process.exit(1)
  }

  log('✅ System dependencies are present!')

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

  const yt = google.youtube({version: 'v3', auth: youTubeApiKey})
  const startFetchMetadata = performance.now()
  log(
    `\n👉 Getting partial video metadata for ${
      mostRecentItemsCount || 'all'
    } items...`
  )

  const youTubeFetchCount = {count: 0}
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
        error,
        date: Date.now(),
      })
    }
  }

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
          thumbnailUrl:
            snippet.thumbnails.maxres?.url ??
            snippet.thumbnails.standard?.url ??
            snippet.thumbnails.high?.url ??
            snippet.thumbnails.medium?.url ??
            snippet.thumbnails.default?.url ??
            null,
          url: `https://www.youtube.com/watch?v=${snippet.resourceId.videoId}`,
          channelUrl: `https://www.youtube.com/channel/${snippet.videoOwnerChannelId}`,
          isUnavailable,
        })
      }
    })

    return acc
  }, [])
  const partialVideosMetadataObj = partialVideosMetadata.reduce<
    Record<string, PartialVideo>
  >((acc, partialVideo) => {
    acc[partialVideo.id] = partialVideo
    return acc
  }, {})

  /**
   * Filter out unavailable video ids to potentially reduce how many fetch calls
   * are made to the YouTube Videos List API.
   */
  const videoIdsToFetch = partialVideosMetadata.reduce<string[]>(
    (acc, {id, isUnavailable}) => {
      if (!isUnavailable) acc.push(id)
      return acc
    },
    []
  )

  // Add missing metadata to unavailable videos.
  const unavailableVideos = partialVideosMetadata.reduce<Video[]>(
    (acc, partialVideo) => {
      if (partialVideo.isUnavailable) {
        acc.push({
          ...partialVideo,
          durationInSeconds: 0,
          audioFileExtension: null,
          videoFileExtension: null,
        })
      }

      return acc
    },
    []
  )

  log(
    `👉 Getting remaining video metadata for ${pluralize(
      videoIdsToFetch.length,
      'item'
    )}...`
  )

  /**
   * Create an array of id arrays that are 50 ids each:
   *
   * [[50 ids], [50 ids], ...]
   */
  const chunkedVideoIdsToFetch = chunkArray(
    videoIdsToFetch,
    MAX_YOUTUBE_RESULTS
  )

  /**
   * Each call to the
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * can specify a max of 50 ids. We want to run a number of concurrent fetch
   * calls, so further chunk the array.
   */
  const fetchIdChunks = chunkArray(
    chunkedVideoIdsToFetch,
    maxConcurrentFetchCalls
  )

  /**
   * Uses the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list)
   * to fetch additional metadata for each video.
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
        error,
        date: Date.now(),
      })
    }
  }

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

  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`
  // 💡 Directories may now exist - they will be created at a later step.
  const [existingAudioIdsOnDiskSet, existingVideoIdsOnDiskSet] = [
    audioDir,
    videoDir,
  ].map(dir => {
    return new Set<string>(
      (() => {
        try {
          return fs.readdirSync(dir).reduce<string[]>((acc, item) => {
            const id = item.match(squareBracketIdRegex)?.[1]
            if (id) acc.push(id)

            return acc
          }, [])
        } catch {
          // The directory doesn't exist yet. We'll create it later.
          return []
        }
      })()
    )
  }) as [Set<string>, Set<string>]
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
        (!existingAudioIdsOnDiskSet.has(id) ||
          !existingVideoIdsOnDiskSet.has(id))
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
    const audioExistsOnDisk = existingAudioIdsOnDiskSet.has(id)
    const videoExistsOnDisk = existingVideoIdsOnDiskSet.has(id)
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
          downloadCount.audio++
          downloadCount.video++

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
          downloadCount.video++

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
          downloadCount.audio++

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
   * The actual download!
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
    const errorCount = failures.reduce((count, failure) => {
      if (
        failure.type === 'ytdlpFailure' ||
        (failure.type === 'schemaParse' &&
          failure.schemaName === 'YtDlpJsonSchema')
      ) {
        count++
      }

      return count
    }, 0)
    const errorMsg = errorCount ? ` ${pluralize(errorCount, 'error')}` : ''
    const icon = errorCount ? '💡' : '✅'

    log(`${icon} ${downloadVerb} complete!${errorMsg} [${processingTime}]`)
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

    const thumbnailsToDownload = potentialVideosToDownload.reduce<
      {url: string; id: string}[]
    >((acc, video) => {
      const {thumbnailUrl, id} = video

      if (!existingThumbnailIdsOnDiskSet.has(id) && thumbnailUrl) {
        acc.push({url: thumbnailUrl, id})
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
              batch.map(({url, id}) => {
                return downloadThumbnailFile({
                  url,
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

      log(
        `✅ Thumbnails downloaded! [${sanitizeTime(
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
   *
   * We have a newly constructed
   */

  if (freshMetadata.length) {
    log('\n👉 Updating metadata.json...')

    let metadataItemsUpdated = 0
    const startUpdateMetadata = performance.now()
    const metadataJsonPath = `${directory}/metadata.json`
    const existingMetadata: Video[] = await Bun.file(metadataJsonPath)
      .json()
      .catch(() => []) // In case the file doesn't exist yet.

    // This object will be updated with any new video data we have.
    const existingMetadataObj = existingMetadata.reduce<Record<string, Video>>(
      (acc, video) => {
        acc[video.id] = video
        return acc
      },
      {}
    )

    /**
     * The Videos List API won't return any data for unavailable videos. We
     * explicitly concat them here so they can be included in the metadata.
     */
    const totalMetadata = freshMetadata.concat(unavailableVideos)

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
          const existingAudioExt = existingVideo.audioFileExtension
          const existingVideoExt = existingVideo.videoFileExtension

          // Videos exist in both sets - most likely a file extension change.
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
          error,
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
      acc[type].push(rest)

      return acc
    },
    {
      'Bun.write': [],
      schemaParse: [],
      videosListApi: [],
      partialVideoNotFound: [],
      ytdlpFailure: [],
      downloadThumbnail: [],
    }
  )

  return {
    youTubeFetchCount: youTubeFetchCount.count,
    downloadCount,
    failureData,
  }
}

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
  url,
  id,
  thumbnailDirectory,
}: {
  url: string
  id: string
  thumbnailDirectory: string
}): Promise<undefined> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {'Content-Type': 'image/jpeg'},
  })

  if (!res.ok) {
    const failure: Failure = {
      type: 'downloadThumbnail',
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
      error,
      date: Date.now(),
    }

    throw failure
  }
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
const squareBracketIdRegex = /\[([a-zA-Z0-9_-]+)\]\.\w+$/

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

type CategoryInfo = {
  totalSize: number
  files: {file: string; id: string}[]
  extensionSet: Set<string>
}

type Stat = {
  type: string
  fileCount: number
  extensions: string
  totalSize: string
}

export function getStats(directory: string): Stat[] {
  const {audioData, videoData, thumbnailData} = [
    `${directory}/audio`,
    `${directory}/video`,
    `${directory}/thumbnails`,
  ].reduce<{
    audioData: CategoryInfo
    videoData: CategoryInfo
    thumbnailData: CategoryInfo
  }>(
    (acc, dir) => {
      if (!fs.existsSync(dir)) return acc

      fs.readdirSync(dir).forEach(file => {
        const id = file.match(squareBracketIdRegex)?.[1]
        const bunFile = Bun.file(`${dir}/${file}`)
        const type = bunFile.type.split('/')[0]
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
    .reduce<Stat[]>((acc, {totalSize, ...rest}) => {
      if (totalSize) {
        acc.push({...rest, totalSize: bytesToSize(totalSize)})
      }

      return acc
    }, [])
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

export function getMissingThumbnailIds(directory: string) {
  const audioDir = `${directory}/audio`
  const videoDir = `${directory}/video`
  const thumbnailDir = `${directory}/thumbnails`

  const thumbnailIdsSet = fs
    .readdirSync(thumbnailDir)
    .reduce<Set<string>>((acc, item) => {
      if (item.endsWith('.jpg')) acc.add(item.slice(0, -4))
      return acc
    }, new Set())
  const audioVideoIdsSet = [audioDir, videoDir].reduce<Set<string>>(
    (acc, dir) => {
      try {
        fs.readdirSync(dir).forEach(item => {
          const id = item.match(squareBracketIdRegex)?.[1]
          if (id) acc.add(id)
          return acc
        })
      } catch {
        // noop - directory likely doesn't exist.
      }

      return acc
    },
    new Set()
  )

  const thumbnailIdsWithoutVideoOrAudio: string[] = []
  thumbnailIdsSet.forEach(id => {
    if (!audioVideoIdsSet.has(id)) {
      thumbnailIdsWithoutVideoOrAudio.push(id)
    }
  })

  const missingThumbnailIds: string[] = []
  audioVideoIdsSet.forEach(id => {
    if (!thumbnailIdsSet.has(id)) {
      missingThumbnailIds.push(id)
    }
  })

  return {thumbnailIdsWithoutVideoOrAudio, missingThumbnailIds}
}

export async function downloadVideo({
  url,
  downloadType,
  directory,
  format,
  overwrite = false,
}: {
  /** YouTube video URL. */
  url: string

  /** Specify `'audio'` or `'video'`. */
  downloadType: 'video' | 'audio'

  /** Absolute path where the downloaded video should be saved. */
  directory: string

  /**
   * Optional - defaults to `'mp3'` for audio and `'mp4'` for video.
   *
   * A valid yt-dlp audio or video format (depending on `downloadType`).
   */
  format?: string

  /**
   * Optional - default `false`
   *
   * Overwrites files if they already exist.
   */
  overwrite?: boolean
}) {
  const start = performance.now()
  const fileFormat = format ?? (downloadType === 'audio' ? 'mp3' : 'mp4')

  async function handlePromise({exitCode, stderr}: ShellOutput) {
    if (exitCode !== 0) {
      console.error(stderr.toString())
      process.exit(exitCode)
    }

    const time = performance.now() - start
    console.log(`✅ Download complete! [${sanitizeTime(time)}]`)
  }

  console.log(`👉 Downloading ${downloadType}...`)

  /**
   * First we get JSON metadata from yt-dlp so we can get the video title and
   * sanitize it. Then we download the video accordingly.
   */
  return $`yt-dlp -J ${url}`
    .quiet()
    .then(({exitCode, stdout, stderr}) => {
      if (exitCode !== 0) {
        console.error(stderr.toString())
        process.exit(exitCode)
      }

      const rawTitle = JSON.parse(stdout.toString().trim()).title as string
      return sanitizeTitle(rawTitle)
    })
    .then(title => {
      const template = `${directory}/${title} [%(id)s].%(ext)s`
      const extensionsObj = fs
        .readdirSync(directory)
        .reduce<{audio: boolean; video: boolean}>(
          (acc, item) => {
            const id = item.match(squareBracketIdRegex)?.[1]

            if (id) {
              const type = Bun.file(`${directory}/${item}`).type.split('/')[0]

              if (type === 'audio') acc.audio = true
              if (type === 'video') acc.video = true
            }

            return acc
          },
          {audio: false, video: false}
        )

      if (downloadType === 'audio') {
        if (extensionsObj.audio && !overwrite) {
          console.log(
            '🚫 File already exists. To overwrite, pass `overwrite: true`.'
          )
          process.exit()
        }

        return $`yt-dlp -o "${template}" --extract-audio --audio-format="${fileFormat}" -J --no-simulate ${url}`.quiet()
      }

      if (extensionsObj.video && !overwrite) {
        console.log(
          '🚫 File already exists. To overwrite, pass `overwrite: true`.'
        )
        process.exit()
      }

      return $`yt-dlp -o "${template}" --format="${fileFormat}" -J --no-simulate ${url}`.quiet()
    })
    .then(handlePromise)
}
