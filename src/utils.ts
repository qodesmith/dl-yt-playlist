import {youtube_v3} from '@googleapis/youtube'
import {execSync} from 'child_process'
import fs from 'node:fs'
import type {PageData} from './youtubeApiCalls'

type VideoDateData = {
  dateAddedToPlaylist: string
  dateCreated: string | null
}

export type VideoIdAndDates = Record<string, VideoDateData>

/**
 * Returns an object where the keys are video ids and the values are the dates
 * those videos were added to the playlist.
 */
export function getVideoIdsAndDatesAddedFromPlaylistResponse(playlistResponse: {
  data: youtube_v3.Schema$PlaylistItemListResponse
}): VideoIdAndDates {
  if (!playlistResponse.data.items) {
    throw new Error('Missing playlistResponse.data.items')
  }

  return playlistResponse.data.items.reduce<VideoIdAndDates>(
    (acc, {contentDetails, snippet}) => {
      if (!contentDetails?.videoId) {
        throw new Error('`contentDetails.videoId` missing from playlist item')
      }

      // Date added to playlist.
      if (!snippet?.publishedAt) {
        throw new Error('`snippet.publishedAt` missing from playlist item')
      }

      acc[contentDetails.videoId] = {
        // If this is missing, it is because the video is private or deleted.
        dateCreated: contentDetails.videoPublishedAt ?? null,
        dateAddedToPlaylist: snippet.publishedAt,
      }

      return acc
    },
    {}
  )
}

type GetUnavailableVideoPlaylistItemIdsInput = Pick<
  PageData,
  'playlistResponse' | 'videosResponse'
>

export function getUnavailableVideoPlaylistItemIds({
  playlistResponse,
  videosResponse,
}: GetUnavailableVideoPlaylistItemIdsInput): string[] {
  const playlistItems = playlistResponse.data.items ?? []
  const videoItems = videosResponse.data.items ?? []
  const videosResponseIdSet = new Set(videoItems.map(({id}) => id))

  /**
   * Missing videos are calculated by diff'ing the id's from the
   * playlistResponse (which contain all videos, even those deleted or removed)
   * and the id's from the videosResponse, which only contains available videos.
   */
  return playlistItems.reduce<string[]>((acc, {contentDetails}) => {
    const {videoId} = contentDetails ?? {}

    if (videoId && !videosResponseIdSet.has(videoId)) {
      acc.push(videoId)
    }

    return acc
  }, [])
}

export type Video = {
  id: string
  title: string
  channel: string
  dateCreated: VideoDateData['dateCreated']
  dateAddedToPlaylist: VideoDateData['dateAddedToPlaylist']
  url: string
  lengthInSeconds: number
}

/**
 * Notes about the metadata:
 * - The audio bitrate is only available to the video owner
 * - dateAddedToPlaylist - calculated from `playlistMetaData.snippet.publishedAt`
 * - publishedAt - date the video was published (`item.snippet.publishedAt`)
 * - lengthInSeconds - `item.contentDetails.duration` - the format is IS0 8601 duration
 */
export function getVideoMetadata(allPages: PageData[]): Video[] {
  return allPages
    .reduce((acc: Video[], {videosResponse, videoIdsAndDates}) => {
      videosResponse.data.items?.forEach(item => {
        const {id} = item
        if (!id) return acc

        const {dateAddedToPlaylist, dateCreated} = videoIdsAndDates[id]
        const {channelTitle: channel, title} = item.snippet ?? {}
        const url = `https://www.youtube.com/watch?v=${id}`
        const lengthInSeconds = parseISO8601Duration(
          item.contentDetails?.duration
        )

        if (!id || !title || !channel || lengthInSeconds === null) {
          throw new Error('Property missing from video')
        }

        acc.push({
          id,
          title,
          channel,
          dateCreated,
          dateAddedToPlaylist,
          url,
          lengthInSeconds,
        })
      })

      return acc
    }, [])
    .sort((a, b) => {
      if (a.dateAddedToPlaylist < b.dateAddedToPlaylist) return 1
      if (a.dateAddedToPlaylist > b.dateAddedToPlaylist) return -1
      return 0
    })
}

function parseISO8601Duration(durationString: string | undefined | null) {
  if (!durationString) return null

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
 * Download a YouTube video as an mp3 file using the `yt-dlp` command line
 * package. You can conveniently install it with `brew install yt-dlp`.
 */
async function downloadVideo({
  videoUrl,
  playlistName,
  audioOnly,
  directory,
}: {
  videoUrl: string
  playlistName: string
  audioOnly: boolean | undefined
  directory: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * https://github.com/yt-dlp/yt-dlp#output-template
     * This is Python syntax and the trailing 's' after the parenthesis
     * indicates the preceding value is a string.
     *
     * https://www.perplexity.ai/search/fb927e12-6b12-4fac-b33d-363c760661ca?s=u
     * Prefer `title` over `fulltitle`
     */
    const subFolder = audioOnly ? 'audio' : 'video'
    const template = `-o '${directory}/${playlistName}/${subFolder}/%(title)s [%(id)s].%(ext)s'`
    const options = audioOnly
      ? '--extract-audio --audio-format mp3 --audio-quality 0'
      : '-f mp4'

    // https://github.com/yt-dlp/yt-dlp
    const command = `yt-dlp ${template} ${options} -- ${videoUrl}`

    /**
     * Exec doesn't seem to call its callback function when the command is done:
     * exec(command, error => error ? reject(error) : resolve())
     *
     * An internet search reveals that if the process doesn't print to stdout,
     * it's possible the callback will never be called. Avoiding all that with
     * `execSync`.
     */
    try {
      execSync(command)
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Download all YouTube videos as mp3 files using the `yt-dlp` command line
 * package.
 */
export async function downloadAllVideos({
  videos,
  existingIds,
  maxLengthInSeconds,
  playlistName,
  audioOnly,
  directory,
}: {
  videos: Video[]
  existingIds: Set<string>
  maxLengthInSeconds: number
  playlistName: string
  audioOnly: boolean
  directory: string
}): Promise<ResultsMetadata> {
  // Avoid fetching and creating audio we already have.
  const videosToProcess = videos.filter(({id, lengthInSeconds}) => {
    return !existingIds.has(id) && lengthInSeconds <= maxLengthInSeconds
  })
  const totalVideoCount = videosToProcess.length
  const failures: Failure[] = []

  if (!totalVideoCount) {
    console.log('😎 All videos already accounted for')
    return getResultsMetadata({
      failures,
      totalVideosDownloaded: totalVideoCount,
    })
  }

  const promiseFxns = videosToProcess.map(({title, url}, i) => {
    const counter = `(${i + 1} of ${totalVideoCount})`

    return async () => {
      console.log(`${counter} Downloading ${title}...`)

      return downloadVideo({videoUrl: url, playlistName, audioOnly, directory})
        .then(() => {
          console.log(`${counter} ✅ Success!`)
        })
        .catch((error: unknown) => {
          failures.push({url, title, error})
          console.log(`${counter} ❌ Failed to download`)
        })
    }
  })

  return promiseFxns
    .reduce((acc, fxn) => acc.then(fxn), Promise.resolve())
    .then(() =>
      getResultsMetadata({failures, totalVideosDownloaded: totalVideoCount})
    )
}

type Failure = {url: string; title: string; error: unknown}

export type ResultsMetadata = {
  failures: Failure[]
  failureCount: number
  date: string
  dateNum: number
  totalVideosDownloaded: number
  totalThumbnailsDownloaded: number
}

export function getResultsMetadata({
  failures = [],
  totalVideosDownloaded = 0,
  totalThumbnailsDownloaded = 0,
}: {
  failures?: Failure[]
  totalVideosDownloaded?: number
  totalThumbnailsDownloaded?: number
} = {}): ResultsMetadata {
  const date = new Date()

  return {
    failures: failures.map(({error, ...failure}) => ({
      error: `${error}`,
      ...failure,
    })),
    failureCount: failures.length,
    date: date.toLocaleString(),
    dateNum: +date,
    totalVideosDownloaded,
    totalThumbnailsDownloaded,
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
export const squareBracketIdRegex = /\[([a-zA-Z0-9_-]+)\]\.\w+$/

/**
 * Reads the './data/audio' folder, iterates through all the files, and pulls
 * out the YouTube id from each file. Returns a set of the ids.
 *
 * File format is: `<title> [<id>].mp3`
 */
export function getExistingVideoIds({
  playlistName,
  audioOnly,
  directory,
}: {
  playlistName: string
  audioOnly: boolean
  directory: string
}): Set<string> {
  const subFolder = audioOnly ? 'audio' : 'video'
  const existingFileNames = fs.readdirSync(
    `${directory}/${playlistName}/${subFolder}`
  )

  return existingFileNames.reduce((acc, fileName) => {
    // 'Video Title [123-_abc123].mp3' => '123-_abc123'
    const id = fileName.match(squareBracketIdRegex)?.[1]
    if (id) acc.add(id)

    return acc
  }, new Set<string>())
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}

/**
 * Iterates through `responses.json` to aggregate the highest resolution of all
 * video thumbnails and downloads them.
 */
export async function downloadAllThumbnails({
  fullData,
  directory,
  resultsMetadata,
}: {
  fullData: PageData[]
  directory: string
  resultsMetadata: ResultsMetadata
}) {
  const thumbnailFailures: Failure[] = []
  const existingThumbnailSet = new Set(
    fs.readdirSync(directory).reduce<string[]>((acc, fileName) => {
      if (fileName.endsWith('.jpg')) acc.push(fileName.slice(0, -4))
      return acc
    }, [])
  )
  const allThumbnailUrls = fullData.reduce<
    {url: string; id: string; title: string}[]
  >((acc, responseItem) => {
    responseItem.playlistResponse.data.items?.forEach(item => {
      const thumbnailData = item.snippet?.thumbnails ?? {}
      const title = item.snippet?.title ?? ''
      const id = item.contentDetails?.videoId

      // Skip files we already have downloaded.
      if (id && existingThumbnailSet.has(id)) return

      const thumbnailUrl = (() => {
        // https://developers.google.com/youtube/v3/docs/playlistItems#resource
        const resolutions: (keyof typeof thumbnailData)[] = [
          'maxres',
          'high',
          'standard',
          'medium',
          'default',
        ]

        for (const resolution of resolutions) {
          const obj = thumbnailData[resolution]
          if (obj) return obj.url
        }
      })()

      if (id && thumbnailUrl) acc.push({id, url: thumbnailUrl, title})
    })

    return acc
  }, [])
  const promiseFxns = allThumbnailUrls.map(({url, id, title}) => {
    return async () => {
      try {
        const res = await fetch(url)
        const buffer = await res.arrayBuffer()
        await Bun.write(`${directory}/${id}.jpg`, buffer)
      } catch (error) {
        thumbnailFailures.push({url, title, error})
        console.log(`❌ Failed to download thumbnail (${id}) - ${url}`)
      }
    }
  })
  const chunkSize = 4
  const promiseFxnChunks = chunkArray(promiseFxns, chunkSize)
  const chunkCount = promiseFxnChunks.length

  /**
   * Trigger the promises sequentially in batches and wait for all of them to
   * finish.
   */
  await promiseFxnChunks.reduce((accPromise, promiseFxnsArr, i) => {
    const counter = `(${i + 1} of ${chunkCount})`

    return accPromise.then(() => {
      console.log(`${counter} Downloading thumbnail batch of ${chunkSize}...`)

      const promises = promiseFxnsArr.map(fxn => fxn())
      return Promise.all(promises).then(() => {
        console.log(`${i + 1} of ${chunkCount} ✅ Success!`)
      })
    })
  }, Promise.resolve())

  return getResultsMetadata({
    failures: resultsMetadata.failures.concat(thumbnailFailures),
    totalVideosDownloaded: resultsMetadata.totalVideosDownloaded,
    totalThumbnailsDownloaded:
      allThumbnailUrls.length - thumbnailFailures.length,
  })
}
