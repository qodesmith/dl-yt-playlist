import type {Errorlike, SpawnOptions, Subprocess} from 'bun'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import sanitizeFilename from 'sanitize-filename'
export type DownloadType = 'audio' | 'video' | 'both' | 'none'

export function checkSystemDependencies(downloadType: DownloadType) {
  const messageLoggers: (() => void)[] = []
  const ytDlpPath = Bun.which('yt-dlp')

  if (!ytDlpPath) messageLoggers.push(logMissingYtDlp)

  if (downloadType === 'both' || downloadType === 'audio') {
    const ffmpegPath = Bun.which('ffmpeg')
    if (!ffmpegPath) messageLoggers.push(logMissingFfmpeg)
  }

  return messageLoggers
}

function logMissingYtDlp() {
  console.log('\nCould not find the `yt-dlp` package on this system.')
  console.log('This package is needed to download YouTube videos.')
  console.log(
    'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
  )
}

function logMissingFfmpeg() {
  console.log('\nCould not find the `ffmpeg` package on this system.')
  console.log('This package is needed to extract audio from YouTube videos.')
  console.log(
    'You can download a binary at https://www.ffmpeg.org/download.html or run `brew install ffmpeg`.'
  )
}

export const fileAndFolderNames = {
  audio: 'audio',
  video: 'video',
  thumbnails: 'thumbnails',
  json: 'metadata.json',
  playlistResponses: 'youtubePlaylistResponses.json',
  videoResponses: 'youtubeVideoResponses.json',
} as const

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
  const {audio, video, thumbnails, json, playlistResponses, videoResponses} =
    fileAndFolderNames
  const playlistDirectory = `${directory}/${playlistName}`
  const pathNames = {
    playlist: playlistDirectory,
    audio: `${playlistDirectory}/${audio}`,
    video: `${playlistDirectory}/${video}`,
    thumbnails: `${playlistDirectory}/${thumbnails}`,
    json: `${playlistDirectory}/${json}`,
    playlistResponses: `${playlistDirectory}/${playlistResponses}`,
    videoResponses: `${playlistDirectory}/${videoResponses}`,
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

/**
 * Reads the existing json file and returns an object in the shape of
 * `{id: Video}[]`
 */
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
    return arrayToIdObject(dataArr)
  } catch {
    // Getting here means the file didn't exist.
    return {}
  }
}

/**
 * For each video in the response from YouTube, compare it to what we have in
 * the existing json file on disk.
 *
 * If the existing data doesn't have a video, it will be added to it.
 *
 * If the existing data conflicts with YouTube, it will be updated.
 *
 * The benefit here is if a video has been deleted or gone private, we will
 * retain what information we previously fetched from YouTube as that data will
 * no longer be returned from the YouTube API. We add an `isUnavailable` flag
 * to the video to indicate this scenario.
 *
 * This function will return a new array sorted by `dateAddedToPlaylist`.
 */
export function updateLocalVideosData({
  apiMetadata,
  existingData,
}: {
  /** This represents the massaged response from YouTube. */
  apiMetadata: Video[]

  /** This represents metadata we already had in the json file. */
  existingData: Record<string, Video>
}): Video[] {
  apiMetadata.forEach(currentVideo => {
    const {id} = currentVideo
    const existingVideo = existingData[id]

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
  })

  /**
   * Return an array of the values in `existingData` sorted by date added to the
   * playlist, descending.
   */
  return Object.values(existingData).toSorted((a, b) => {
    const dateNum1 = +new Date(a.dateAddedToPlaylist || 0)
    const dateNum2 = +new Date(b.dateAddedToPlaylist || 0)

    return dateNum2 - dateNum1
  })
}

export function ffmpegCreateAudioFile<T extends {title: string; id: string}>({
  audioPath,
  videoPath,
  video,
  videoFileExtension,
}: {
  audioPath: string
  videoPath: string
  video: T
  videoFileExtension: string
}) {
  const videoFilePath = `${videoPath}/${video.title} [${video.id}]${videoFileExtension}`
  const audioFilePath = `${audioPath}/${video.title} [${video.id}].mp3`
  const ffmpegCmd = [
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

  return new Promise<{
    exitCode: number
    signalCode: number | null
    error: Errorlike | undefined
    command: string[]
    stdin: Awaited<ReturnType<typeof extractStdio>>['stdinRes']
    stdout: Awaited<ReturnType<typeof extractStdio>>['stdoutRes']
    stderr: Awaited<ReturnType<typeof extractStdio>>['stderrRes']
  }>((resolve, reject) => {
    Bun.spawn({
      cmd: ffmpegCmd,
      onExit(subprocess, exitCode, signalCode, error) {
        extractStdio(subprocess).then(({stdinRes, stdoutRes, stderrRes}) => {
          if (error || exitCode !== 0) {
            reject({
              exitCode,
              signalCode,
              error,
              command: ffmpegCmd,
              stdin: stdinRes,
              stdout: stdoutRes,
              stderr: stderrRes,
            })
          } else {
            resolve({
              exitCode,
              signalCode,
              error,
              command: ffmpegCmd,
              stdin: stdinRes,
              stdout: stdoutRes,
              stderr: stderrRes,
            })
          }
        })
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })
}

async function extractStdio(
  subprocess: Subprocess<
    SpawnOptions.Writable,
    SpawnOptions.Readable,
    SpawnOptions.Readable
  >
) {
  const {stdin, stdout, stderr} = subprocess

  const stdinPromise = Promise.resolve(
    stdin instanceof ReadableStream ? Bun.readableStreamToText(stdin) : stdin
  )
  const stdoutPromise = Promise.resolve(
    stdout instanceof ReadableStream ? Bun.readableStreamToText(stdout) : stdout
  )
  const stderrPromise = Promise.resolve(
    stderr instanceof ReadableStream ? Bun.readableStreamToText(stderr) : stderr
  )

  return Promise.all([stdinPromise, stdoutPromise, stderrPromise]).then(
    ([stdinRes, stdoutRes, stderrRes]) => {
      return {
        stdinRes,
        stdoutRes,
        stderrRes,
      }
    }
  )
}

export function sanitizeTitle(str: string): string {
  const safeTitle = sanitizeFilename(str, {replacement: ' '})

  // Use a regular expression to replace consecutive spaces with a single space.
  return safeTitle.replace(/\s+/g, ' ')
}

export async function internalDownloadVideo<
  T extends {url: string; title: string}
>({
  video,
  downloadType,
  audioPath,
  videoPath,
  isSingleDownload,
}: {
  video: T
  downloadType: DownloadType
  audioPath: string
  videoPath: string
  isSingleDownload?: boolean
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
    isSingleDownload ? '-f bestvideo*+bestaudio/best' : '--format=mp4',
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
        throw new Error(
          `Unable to create yt-dlp template from download type "${downloadType}"`
        )
    }
  })()

  const downloadCmd = ['yt-dlp', ...template, url]
  const getNameCmd = ['yt-dlp', '--print=filename', ...template, url]

  /**
   * When downloading a single video, we ask yt-dlp for the highest quality
   * video available. We don't know what that format will be, so we first need
   * to do a "dry run", having yt-dlp tell us what format it will download.
   */
  const filenamePromise = new Promise<string | void>((resolve, reject) => {
    if (isSingleDownload) {
      Bun.spawn({
        cmd: getNameCmd,
        onExit(subprocess, exitCode, signalCode, error) {
          extractStdio(subprocess).then(({stdinRes, stdoutRes, stderrRes}) => {
            if (error || exitCode !== 0) {
              reject({
                exitCode,
                signalCode,
                error,
                command: getNameCmd,
                stdin: stdinRes,
                stdout: stdoutRes,
                stderr: stderrRes,
              })
            } else if (!stdoutRes || typeof stdoutRes !== 'string') {
              reject({
                exitCode,
                signalCode,
                error: new Error('Did not receive a string for the filename'),
                command: getNameCmd,
                stdin: stdinRes,
                stdout: stdoutRes,
                stderr: stderrRes,
              })
            } else {
              const fileExtension = path.parse(stdoutRes.trim()).ext
              resolve(fileExtension)
            }
          })
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } else {
      resolve()
    }
  })

  return filenamePromise.then(videoFileExtension => {
    return new Promise<{
      videoFileExtension: string | void
      exitCode: number | null
      signalCode: number | null
      error: Errorlike | undefined
      command: string[]
      stdin: Awaited<ReturnType<typeof extractStdio>>['stdinRes']
      stdout: Awaited<ReturnType<typeof extractStdio>>['stdoutRes']
      stderr: Awaited<ReturnType<typeof extractStdio>>['stderrRes']
    }>((resolve, reject) => {
      Bun.spawn({
        cmd: downloadCmd,
        onExit(subprocess, exitCode, signalCode, error) {
          extractStdio(subprocess).then(({stdoutRes, stdinRes, stderrRes}) => {
            if (error || exitCode !== 0) {
              reject({
                videoFileExtension,
                exitCode,
                signalCode,
                error,
                command: downloadCmd,
                stdout: stdoutRes,
                stdin: stdinRes,
                stderr: stderrRes,
              })
            } else {
              resolve({
                videoFileExtension,
                exitCode,
                signalCode,
                error,
                command: downloadCmd,
                stdout: stdoutRes,
                stdin: stdinRes,
                stderr: stderrRes,
              })
            }
          })
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
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
  thumbnailDirectory,
}: {
  videos: Video[]
  thumbnailDirectory: ReturnType<typeof createPathData>['thumbnails']
}): Video[] {
  const thumbnailSet = new Set(
    fs.readdirSync(thumbnailDirectory).reduce<string[]>((acc, str) => {
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
  thumbnailDirectory,
}: {
  url: string
  id: string
  thumbnailDirectory: ReturnType<typeof createPathData>['thumbnails']
}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {'Content-Type': 'image/jpeg'},
  })

  if (!res.ok) {
    throw new Error('Network response was not ok')
  }

  return Bun.write(`${thumbnailDirectory}/${id}.jpg`, res)
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

function getExistingVideoIdsSet(
  audioOrVideoDirectory: ReturnType<typeof createPathData>['audio' | 'video']
): Set<string> {
  return fs.readdirSync(audioOrVideoDirectory).reduce((set, fileName) => {
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

export function sanitizeDecimal(num: number): string {
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
 * Converts a number of milliseconds into a plain-english string, such as
 * "4 minutes 32 seconds"
 */
export function sanitizeTime(ms: number): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = sanitizeDecimal(totalSeconds % 60)
  const secondsFinalValue = pluralize(seconds, 'second')

  return minutes
    ? `${pluralize(minutes, 'minute')} ${secondsFinalValue}`
    : secondsFinalValue
}

function pluralize(amount: number | string, word: string): string {
  const s = +amount === 1 ? '' : 's'
  return `${amount} ${word}${s}`
}

export type Failure = {
  url: string
  title: string
  error: unknown
  type: 'video' | 'thumbnail' | 'ffmpeg'
}

export type ResultsMetadata = {
  failures: Failure[]
  failureCount: number
  date: string
  dateNum: number
  totalVideosDownloaded: number
  totalThumbnailsDownloaded: number
}

export function getDefaultResults(): ResultsMetadata {
  const date = new Date()

  return {
    failures: [],
    failureCount: 0,
    date: date.toLocaleDateString(),
    dateNum: +date,
    totalVideosDownloaded: 0,
    totalThumbnailsDownloaded: 0,
  }
}

export function arrayToIdObject<T extends {id: string}>(
  arr: T[]
): Record<string, T> {
  return arr.reduce<Record<string, T>>((acc, item) => {
    acc[item.id] = item
    return acc
  }, {})
}
