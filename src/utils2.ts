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
  }

  fs.mkdirSync(folderNames.playlist)

  if (downloadType === 'audio' || downloadType === 'both') {
    fs.mkdirSync(folderNames.audio)
  }

  if (downloadType === 'video' || downloadType === 'both') {
    fs.mkdirSync(folderNames.video)
  }

  if (downloadThumbnails) {
    fs.mkdirSync(folderNames.thumbnails)
  }
}

type Video = {
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
  durationInSeconds: string

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
  dateCreated: string

  // Absolute path to where the downloaded audio mp3 lives.
  mp3Path?: string

  // Absolute path to where the downloaded video mp4 lives.
  mp4Path?: string
}

export type PartialVideo = Pick<
  Video,
  | 'id'
  | 'title'
  | 'channelId'
  | 'channelName'
  | 'dateAddedToPlaylist'
  | 'url'
  | 'thumbnaillUrl'
  | 'isUnavailable'
>

export function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from({length: Math.ceil(arr.length / size)}, (v, i) =>
    arr.slice(i * size, i * size + size)
  )
}
