import fs from 'node:fs'
import {Video, sanitizeDecimal} from './utils'

const extensions = {
  audio: 'mp3',
  video: 'mp4',
  thumbnails: 'jpg',
} as const

type FolderData = {
  playlistName: string
  fileType: GetFolderDataArg['extension']
  totalFiles: number
  totalSize: string
}

export function getStats(rootDir: string): FolderData[] {
  return fs.readdirSync(rootDir).flatMap(dir => {
    return (['audio', 'video', 'thumbnails'] as const).reduce<FolderData[]>(
      (acc, subDir) => {
        try {
          const folderDir = `${rootDir}/${dir}/${subDir}`
          const stats = fs.statSync(folderDir)

          if (stats.isDirectory()) {
            acc.push(
              getFolderData({
                dir: folderDir,
                extension: extensions[subDir],
                playlistName: dir,
              })
            )
          }
        } catch (e) {}

        return acc
      },
      []
    )
  })
}

type GetFolderDataArg = {
  dir: string
  extension: 'mp3' | 'mp4' | 'jpg'
  playlistName: string
}

function getFolderData({
  dir,
  extension,
  playlistName,
}: GetFolderDataArg): FolderData {
  const fileNames = fs
    .readdirSync(dir)
    .filter(item => item.endsWith(`.${extension}`))
  const totalSize = fileNames.reduce((acc, fileName) => {
    const {size} = fs.statSync(`${dir}/${fileName}`)
    return acc + size
  }, 0)

  return {
    playlistName,
    fileType: extension,
    totalFiles: fileNames.length,
    totalSize: bytesToSize(totalSize),
  }
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

/**
 * These are videos that have been download but are no longer available.
 * Videos may have been deleted or turned private.
 */
export function getDeactivatedVideos(rootDir: string) {
  const metadata: Video[] = JSON.parse(
    fs.readFileSync(`${rootDir}/metadata.json`, {
      encoding: 'utf8',
    })
  )

  return metadata
    .filter(({isUnavailable}) => !!isUnavailable)
    .map(({id, dateAddedToPlaylist, dateCreated, channelId, channelName}) => ({
      id,
      dateAddedToPlaylist,
      dateCreated,
      channelId,
      channelName,
    }))
}
