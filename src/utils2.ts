import fs from 'node:fs'

export type DownloadType = 'audio' | 'video' | 'both'

/**
 * Creates a folder with the playlist name and a few sub-folders conditionlly:
 *
 * - `{playlistName}/audio`
 * - `{playlistName}/video`
 * - `{playlistName}/thumbnails`
 */
export function createFolders({
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
  const folderNames = {
    playlist: `${directory}/${playlistName}`,
    audio: `${directory}/${playlistName}/audio`,
    video: `${directory}/${playlistName}/video`,
    thumbnails: `${directory}/${playlistName}/thumbnails`,
    audioJson: `${directory}/${playlistName}/audio.json`,
    videoJson: `${directory}/${playlistName}/video.json`,
  }

  createFolderSafely(folderNames.playlist)

  if (downloadType === 'audio' || downloadType === 'both') {
    createFolderSafely(folderNames.audio)
  }

  if (downloadType === 'video' || downloadType === 'both') {
    createFolderSafely(folderNames.video)
  }

  if (downloadThumbnails) {
    createFolderSafely(folderNames.thumbnails)
  }

  return folderNames
}

function createFolderSafely(dir: string) {
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

  // Absolute path to where the downloaded thumbnail jpg lives.
  thumbnailPath: string

  // videosListResponse.data.items[number].snippet.publishedAt
  dateCreated: string

  // Absolute path to where the downloaded audio mp3 lives.
  mp3Path?: string | null

  // Absolute path to where the downloaded video mp4 lives.
  mp4Path?: string | null
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

export async function genExistingVideosData({
  folders,
}: {
  folders: ReturnType<typeof createFolders>
}): Promise<{
  existingAudioData: Record<string, Video>
  existingVideoData: Record<string, Video>
}> {
  const [existingAudioData, existingVideoData] = await Promise.all([
    genExistingVideoJson(folders.audioJson),
    genExistingVideoJson(folders.videoJson),
  ])

  return {existingAudioData, existingVideoData}
}

async function genExistingVideoJson(
  dir: string
): Promise<Record<string, Video>> {
  try {
    const audioJsonRaw = JSON.parse(await Bun.file(`${dir}`).json()) as Video[]

    return audioJsonRaw.reduce<Record<string, Video>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {})
  } catch {
    return {}
  }
}

export function updateLocalVideosData({
  videosData,
  existingAudioData,
  existingVideoData,
}: {
  videosData: Video[]
  existingAudioData: Record<string, Video>
  existingVideoData: Record<string, Video>
}) {
  videosData.forEach(currentVideo => {
    const {id} = currentVideo
    const existingMp3Video = existingAudioData[id]
    const existingMp4Video = existingVideoData[id]
    updateVideoData({
      currentVideo,
      existingVideo: existingMp3Video,
      existingVideoData,
    })
    updateVideoData({
      currentVideo,
      existingVideo: existingMp4Video,
      existingVideoData,
    })
  })

  const newAudioData = Object.values(existingAudioData).sort((a, b) => {
    const dateNum1 = +new Date(a.dateAddedToPlaylist)
    const dateNum2 = +new Date(b.dateAddedToPlaylist)

    return dateNum2 - dateNum1
  })

  const newVideoData = Object.values(existingVideoData).sort((a, b) => {
    const dateNum1 = +new Date(a.dateAddedToPlaylist)
    const dateNum2 = +new Date(b.dateAddedToPlaylist)

    return dateNum2 - dateNum1
  })

  return {newAudioData, newVideoData}
}

function updateVideoData({
  currentVideo,
  existingVideo,
  existingVideoData,
}: {
  currentVideo: Video
  existingVideo: Video | undefined
  existingVideoData: Record<string, Video>
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
      existingVideoData[id] = currentVideo
    }
  } else {
    // This is a new video that we did not have in our local data - save it.
    existingVideoData[id] = currentVideo
  }
}
