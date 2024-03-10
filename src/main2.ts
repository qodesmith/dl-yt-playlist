import {DownloadType, createFolders} from './utils2'
import {genPlaylistItems, genPlaylistName} from './youtubeApiCalls2'
import google from '@googleapis/youtube'

export async function downloadYouTubePlaylist({
  playlistId,
  apiKey,
  directory,
  fullData = false,
  maxSecondsDuration = Infinity,
  downloadData = true,
  downloadType = 'audio',
  downloadThumbnails = true,
}: {
  playlistId: string
  apiKey: string
  directory: string
  fullData?: boolean
  maxSecondsDuration?: number
  downloadType?: DownloadType
  downloadData?: boolean
  downloadThumbnails?: boolean
}) {
  // First check if we have `yt-dlp` installed on the system.
  try {
    const proc = Bun.spawnSync(['yt-dlp', '--version'])
    const hasStdout = proc.stdout.toString().length !== 0
    const hasStderr = proc.stderr.toString().length !== 0

    if (!hasStdout || hasStderr) {
      console.log('Could not find the `yt-dlp` package on this system.')
      console.log(
        'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
      )
      process.exit(1)
    }
  } catch (e) {
    console.log('Could not find the `yt-dlp` package on this system.')
    console.log(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )
    process.exit(1)
  }

  const yt = google.youtube({version: 'v3', auth: apiKey})
  const playlistName = await genPlaylistName({yt, playlistId})

  createFolders({directory, playlistName, downloadType, downloadThumbnails})

  const playlistItemsApiResponses = await genPlaylistItems({
    yt,
    playlistId,
    fullData,
  })

  playlistItemsApiResponses.map(item => {})
}
