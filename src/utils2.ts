import fs from 'node:fs'

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

export async function genExistingData({
  audioPath,
  videoPath,
}: {
  audioPath: ReturnType<typeof createPathData>['audio']
  videoPath: ReturnType<typeof createPathData>['video']
}): Promise<Record<string, Video>> {
  const [existingAudioData, existingVideoData] = await Promise.all([
    await genExistingDataObj(audioPath),
    await genExistingDataObj(videoPath),
  ])

  return {...existingAudioData, ...existingVideoData}
}

async function genExistingDataObj(dir: string): Promise<Record<string, Video>> {
  try {
    const dataArr = (await Bun.file(`${dir}`).json()) as Video[]

    return dataArr.reduce<Record<string, Video>>((acc, video) => {
      acc[video.id] = video
      return acc
    }, {})
  } catch {
    /**
     * Getting here means the file didn't exist. This is Bun's preferred way to
     * read files - don't check if they exist, rather, use a try/catch to handle
     * the exception.
     */
    return {}
  }
}

export function updateLocalVideosData({
  apiMetadata,
  existingData,
}: {
  apiMetadata: Video[]
  existingData: Record<string, Video>
}) {
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
       * in our local data, retaining all other data that the YouTube API will
       * no longer return to us.
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
  const mp4Template = `-o "${videoPath}/%(title)s [%(id)s].%(ext)s" -f mp4`
  const mp3Template = `-o "${audioPath}/%(title)s [%(id)s].%(ext)s" --extract-audio --audio-format mp3 --audio-quality 0`
  const template = (() => {
    switch (downloadType) {
      case 'audio':
        return mp3Template
      case 'video':
        return mp4Template
      case 'both':
        return `${mp4Template} ${mp3Template}`
      default:
        throw new Error('Unable to create yt-dlp template')
    }
  })()
  const command = `yt-dlp ${template} -- ${video.url}`

  console.log(`Downloading ${video.title}`)
  Bun.spawnSync([command])
}
