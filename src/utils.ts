import fs from 'node:fs'
import https from 'node:https'
import sanitizeFilename from 'sanitize-filename'

export type DownloadType = 'audio' | 'video' | 'both' | 'none'

/**
 * Creates a folder with the playlist name and a few sub-folders conditionlly:
 *
 * - `{playlistName}/audio`
 * - `{playlistName}/video`
 * - `{playlistName}/thumbnails`
 */
export function createPathData({
  directory,
  playlistName,
  downloadType,
  downloadThumbnails,
}: {
  directory: string
  playlistName: string
  downloadType: DownloadType
  downloadThumbnails?: boolean
}) {
  const pathNames = {
    playlist: `${directory}/${playlistName}`,
    audio: `${directory}/${playlistName}/audio`,
    video: `${directory}/${playlistName}/video`,
    thumbnails: `${directory}/${playlistName}/thumbnails`,
    json: `${directory}/${playlistName}/metadata.json`,
  } as const

  createPathSafely(pathNames.playlist)

  if (downloadType === 'audio' || downloadType === 'both') {
    createPathSafely(pathNames.audio)
  }

  if (downloadType === 'video' || downloadType === 'both') {
    createPathSafely(pathNames.video)
  }

  if (downloadThumbnails) {
    createPathSafely(pathNames.thumbnails)
  }

  return pathNames
}

function createPathSafely(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir)
  }
}

export type Video = {
  // playlistResponse.data.items[number].snippet.resourceId.videoId
  id: string

  // playlistResponse.data.items[number].snippet.title
  title: string

  // playlistResponse.data.items[number].snippet.videoOwnerChannelId
  channelId: string

  // playlistResponse.data.items[number].snippet.videoOwnerChannelTitle
  channelName: string

  // playlistResponse.data.items[number].snippet.publishedAt
  dateAddedToPlaylist: string

  // videosListResponse.data.items[number].contentDetails.duration
  durationInSeconds: number | null

  /**
   * This value will be changed to `true` when future API calls are made and the
   * video is found to be unavailable. This will allow us to retain previously
   * fetch metadata.
   */
  isUnavailable?: boolean

  // This gets constructed based on the id - https://youtube.com/watch?v=${id}
  url: string

  // playlistResponse.data.items[number].snippet.thumbnails.maxres.url
  thumbnaillUrl: string

  // videosListResponse.data.items[number].snippet.publishedAt
  dateCreated: string
}

export type PartialVideo = Omit<Video, 'durationInSeconds' | 'dateCreated'>

export function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}

export function parseISO8601Duration(
  durationString: string | undefined | null
) {
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

export async function genExistingData(
  metadataPath: ReturnType<typeof createPathData>['json']
): Promise<Record<string, Video>> {
  /**
   * Bun's preferred way to read a file is to wrap it in a try/catch and handle
   * the error. This allows us to skip checking if the file exists first, which
   * is a slower and more costly process.
   */
  try {
    const dataArr = (await Bun.file(`${metadataPath}`).json()) as Video[]

    return dataArr.reduce<Record<string, Video>>((acc, video) => {
      acc[video.id] = video
      return acc
    }, {})
  } catch {
    // Getting here means the file didn't exist.
    return {}
  }
}

/**
 * This function will mutate `existingData` based upon what it finds in
 * `apiMetadata`. The goal is to retain information we may have previously
 * fetched from the YouTube API that is no longer available due to the video
 * being deleted, private, etc.
 *
 * This function will return a new array sorted by `dateAddedToPlaylist`.
 */
export function updateLocalVideosData({
  apiMetadata,
  existingData,
}: {
  apiMetadata: Video[]
  existingData: Record<string, Video>
}): Video[] {
  // Update `existingData`.
  apiMetadata.forEach(currentVideo => {
    const {id} = currentVideo
    const existingVideo = existingData[id]

    updateVideoData({currentVideo, existingVideo, existingData})
  })

  /**
   * Return an array of the values in `existingData` sorted by date added to the
   * playlist, descending.
   */
  return Object.values(existingData).toSorted((a, b) => {
    const dateNum1 = +new Date(a.dateAddedToPlaylist)
    const dateNum2 = +new Date(b.dateAddedToPlaylist)

    return dateNum2 - dateNum1
  })
}

function updateVideoData({
  currentVideo,
  existingVideo,
  existingData,
}: {
  currentVideo: Video
  existingVideo: Video | undefined
  existingData: Record<string, Video>
}) {
  const {id} = currentVideo

  if (existingVideo) {
    if (currentVideo.isUnavailable) {
      /**
       * YouTube is saying this video is unavailable - update just that field
       * in our local data, retaining all other data we have, since YouTube will
       * no longer give it to us.
       */
      existingVideo.isUnavailable = true
    } else if (existingVideo.isUnavailable) {
      /**
       * If a previously unavailable video is now available, update our local
       * data wholesale with the data from YouTube.
       */
      existingData[id] = currentVideo
    }
  } else {
    // This is a new video that we did not have in our local data - save it.
    existingData[id] = currentVideo
  }
}

export function ffmpegCreateAudioFile({
  audioPath,
  videoPath,
  video,
}: {
  audioPath: string
  videoPath: string
  video: Video
}) {
  const videoFilePath = `${videoPath}/${video.title} [${video.id}].mp4`
  const audioFilePath = `${audioPath}/${video.title} [${video.id}].mp3`
  const cmd = [
    'ffmpeg',
    '-i',
    videoFilePath,
    '-vn',
    '-acodec',
    'libmp3lame',
    '-q:a',
    '0',
    audioFilePath,
  ]

  return new Promise<void>((resolve, reject) => {
    Bun.spawn({
      cmd,
      onExit(subprocess, exitCode, signalCode, error) {
        if (error || exitCode !== 0) {
          reject({
            exitCode,
            signalCode,
            error,
            command: cmd.join(' '),
          })
        } else {
          resolve()
        }
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  })
}

export function sanitizeTitle(str: string): string {
  const safeTitle = sanitizeFilename(str, {replacement: ' '})

  // Use a regular expression to replace consecutive spaces with a single space.
  return safeTitle.replace(/\s+/g, ' ')
}

export function downloadVideo({
  video,
  downloadType,
  audioPath,
  videoPath,
}: {
  video: Video
  downloadType: DownloadType
  audioPath: string
  videoPath: string
}) {
  /**
   * Video titles may have special characters in them, but the JSON data
   * doesn't. We use the JSON data (`video.title`) instead of the yt-dlp
   * placeholder (`%(title)s`) to prevent poluting file names.
   */
  const {title, url} = video
  const audioTemplate = [
    '-o',
    `${audioPath}/${title} [%(id)s].%(ext)s`,
    '--extract-audio',
    '--audio-format=mp3',
    '--audio-quality=0',
  ]
  const videoTemplate = [
    '-o',
    `${videoPath}/${title} [%(id)s].%(ext)s`,
    '--format=mp4',
  ]

  const template = (() => {
    switch (downloadType) {
      case 'audio':
        return audioTemplate
      case 'video':
      case 'both':
        return videoTemplate
      default:
        // We should never get here.
        throw new Error('Unable to create yt-dlp template')
    }
  })()

  return new Promise<void>((resolve, reject) => {
    const cmd = ['yt-dlp', ...template, url]

    Bun.spawn({
      cmd,
      onExit(subprocess, exitCode, signalCode, error) {
        if (error || exitCode !== 0) {
          reject({
            exitCode,
            signalCode,
            error,
            command: cmd.join(' '),
          })
        } else {
          resolve()
        }
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  })
}

/**
 * This function exists just so we can know how many thumbnails need to be
 * downloaded before actually downloading them. This will help determine some
 * console.log messages.
 */
export function getThumbnailsToBeDownloaded({
  videos,
  directory,
}: {
  videos: Video[]
  directory: ReturnType<typeof createPathData>['thumbnails']
}): Video[] {
  const thumbnailSet = new Set(
    fs.readdirSync(directory).reduce<string[]>((acc, str) => {
      if (str.endsWith('.jpg')) {
        const id = str.split('.')[0] as string
        acc.push(id)
      }
      return acc
    }, [])
  )
  return videos.reduce<Video[]>((acc, video) => {
    if (!thumbnailSet.has(video.id)) {
      acc.push(video)
    }

    return acc
  }, [])
}

export async function downloadThumbnailFile({
  url,
  id,
  directory,
}: {
  url: string
  id: string
  directory: ReturnType<typeof createPathData>['thumbnails']
}) {
  const res = await fetch(url)
  const buffer = await res.arrayBuffer()
  await Bun.write(`${directory}/${id}.jpg`, buffer)
}

export function getExistingIds({
  downloadType,
  audioPath,
  videoPath,
}: {
  downloadType: DownloadType
  audioPath: ReturnType<typeof createPathData>['audio']
  videoPath: ReturnType<typeof createPathData>['video']
}): {audioIdSet: Set<string>; videoIdSet: Set<string>} {
  return {
    audioIdSet:
      downloadType === 'both' || downloadType === 'audio'
        ? getExistingVideoIdsSet(audioPath)
        : new Set(),
    videoIdSet:
      downloadType === 'both' || downloadType === 'video'
        ? getExistingVideoIdsSet(videoPath)
        : new Set(),
  }
}

function getExistingVideoIdsSet(
  directory: ReturnType<typeof createPathData>['audio' | 'video']
): Set<string> {
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

  return fs.readdirSync(directory).reduce((set, fileName) => {
    const id = fileName.match(squareBracketIdRegex)?.[1]
    if (id) set.add(id)

    return set
  }, new Set<string>())
}

export async function genIsOnline() {
  return new Promise(resolve => {
    https
      .get('https://google.com', () => resolve(true))
      .on('error', () => resolve(false))
  })
}

export function sanitizeTime(ms: number) {
  // Calculate total seconds.
  const totalSeconds = ms / 1000

  // Calculate minutes and seconds.
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = (totalSeconds % 60).toFixed(2) // Round to 2 decimal places.

  return minutes
    ? `${pluralize(minutes, 'minute')} ${seconds} seconds`
    : `${seconds} seconds`
}

function pluralize(amount: number, word: string) {
  const s = amount === 1 ? '' : 's'
  return `${amount} ${word}${s}`
}
