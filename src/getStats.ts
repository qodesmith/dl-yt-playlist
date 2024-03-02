import fs from 'node:fs'

export function getStats(rootDir: string) {
  const dirs = fs
    .readdirSync(rootDir)
    .flatMap(dir => {
      return ['audio', 'video'].map(subDir => {
        try {
          const folderDir = `${rootDir}/${dir}/${subDir}`
          const stats = fs.statSync(folderDir)
          if (!stats.isDirectory()) return

          return getFolderData({
            dir: folderDir,
            extension: subDir === 'audio' ? 'mp3' : 'mp4',
            playlistName: dir,
          })
        } catch (e) {}
      })
    })
    .filter(Boolean)

  console.table(dirs)
}

type GetFolderDataArg = {
  dir: string
  extension: string
  playlistName: string
}

function getFolderData({dir, extension, playlistName}: GetFolderDataArg) {
  const fileNames = fs
    .readdirSync(dir)
    .filter(item => item.endsWith(`.${extension}`))
  const totalSize = fileNames.reduce((acc, fileName) => {
    const {size} = fs.statSync(`${dir}/${fileName}`)
    return acc + size
  }, 0)

  return {
    playlistName,
    fileType: extension === 'mp3' ? 'audio' : 'video',
    totalFiles: fileNames.length,
    totalSize: bytesToSize(totalSize),
  }
}

function bytesToSize(bytes: number) {
  if (bytes >= 1073741824) {
    return processBytesMath(bytes / 1073741824) + ' GB'
  } else if (bytes >= 1048576) {
    return processBytesMath(bytes / 1048576) + ' MB'
  } else if (bytes >= 1024) {
    return processBytesMath(bytes / 1024) + ' KB'
  } else if (bytes > 1) {
    return bytes + ' bytes'
  } else if (bytes == 1) {
    return bytes + ' byte'
  } else {
    return '0 bytes'
  }
}

function processBytesMath(mathResult: number) {
  const [num, decimal] = mathResult.toString().split('.')
  return decimal === '00' ? num : `${num}.${decimal.slice(0, 2)}`
}
