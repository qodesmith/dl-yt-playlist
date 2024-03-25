import fs from 'node:fs'
import {
  Failure,
  Video,
  arrayToIdObject,
  chunkArray,
  downloadThumbnailFile,
  fileAndFolderNames,
  sanitizeDecimal,
  squareBracketIdRegex,
} from './utils'

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
    return (
      [
        fileAndFolderNames.audio,
        fileAndFolderNames.video,
        fileAndFolderNames.thumbnails,
      ] as const
    ).reduce<FolderData[]>((acc, subDir) => {
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
    }, [])
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
  const metadataRecord = arrayToIdObject(metadata)
  const unavailableVideos = metadata.filter(
    ({isUnavailable}) => !!isUnavailable
  )
  const unaccountedForVideos: UnaccountedForVideo[] = (() => {
    const videos: UnaccountedForVideo[] = []
    const audioDir = `${rootDir}/audio` as const
    const videoDir = `${rootDir}/video` as const

    addUnaccountedForVideos({videos, metadataRecord, directory: audioDir})
    addUnaccountedForVideos({videos, metadataRecord, directory: videoDir})

    return videos
  })()

  return {unavailableVideos, unaccountedForVideos}
}

type UnaccountedForVideo = {
  id: string
  title: string
}

function addUnaccountedForVideos({
  videos,
  metadataRecord,
  directory,
}: {
  videos: UnaccountedForVideo[]
  metadataRecord: Record<string, Video>
  directory: `${string}/audio` | `${string}/video`
}): void {
  const extension = directory.endsWith(fileAndFolderNames.audio)
    ? '.mp3'
    : '.mp4'

  try {
    fs.readdirSync(directory).forEach(item => {
      const id = item.match(squareBracketIdRegex)?.[1]

      if (id && item.endsWith(extension) && !metadataRecord[id]) {
        videos.push({id, title: item.slice(0, -4)})
      }
    })
  } catch {}
}

export async function downloadMissingThumbnails(playlistDirectory: string) {
  const thumbnailDirectory =
    `${playlistDirectory}/${fileAndFolderNames.thumbnails}` as const
  const jsonFilePath = `${playlistDirectory}/${fileAndFolderNames.json}`

  /**
   * We use the json file as the source of truth for thumbnail urls.
   * To get the latest json data, run `downloadYouTubePlaylist` again.
   */
  const videoMetadata: Video[] = await Bun.file(jsonFilePath).json()
  const currentThumbnailIdsSet = fs
    .readdirSync(thumbnailDirectory)
    .reduce<Set<string>>((set, item) => {
      if (item.endsWith('.jpg')) {
        set.add(item.split('.')[0] as string)
      }

      return set
    }, new Set())

  const thumbnailsToDownload = videoMetadata.reduce<Video[]>((acc, video) => {
    if (!currentThumbnailIdsSet.has(video.id)) {
      acc.push(video)
    }

    return acc
  }, [])

  const thumbnailChunks = chunkArray(thumbnailsToDownload, 4)
  let totalThumbnailsDownloaded = 0
  const failures: Failure[] = []

  for (let i = 0; i < thumbnailChunks.length; i++) {
    const chunks = thumbnailChunks[i] as Video[]
    const count = `(${i + 1} of ${thumbnailChunks.length})`
    console.log(`${count} Downloading batch of thumbnails...`)

    await Promise.all(
      chunks.map(({url, id, title}) => {
        return downloadThumbnailFile({
          url,
          id,
          thumbnailDirectory,
        })
          .then(() => {
            totalThumbnailsDownloaded++
          })
          .catch(error => {
            failures.push({url, title, error, type: 'thumbnail'})
            console.log(`❌ Failed to download thumbnail (${id}) - ${url}`)
          })
      })
    )
  }

  return {
    failures,
    failureCount: failures.length,
    attemptedDownloadCount: thumbnailsToDownload.length,
    totalThumbnailsDownloaded,
  }
}
