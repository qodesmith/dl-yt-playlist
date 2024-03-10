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
