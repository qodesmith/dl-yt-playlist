import {DownloadType, PartialVideo, createFolders} from './utils2'
import {
  genPlaylistItems,
  genPlaylistName,
  genVideosList,
} from './youtubeApiCalls2'
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

  const partialVideosData = playlistItemsApiResponses.reduce<PartialVideo[]>(
    (acc, response) => {
      response.data.items?.forEach(item => {
        const id = item.snippet?.resourceId?.videoId ?? ''
        const partialVideo: PartialVideo = {
          id,
          title: item.snippet?.title ?? '',
          channelId: item.snippet?.videoOwnerChannelId ?? '',
          channelName: item.snippet?.videoOwnerChannelTitle ?? '',
          dateAddedToPlaylist: item.snippet?.publishedAt ?? '',
          thumbnaillUrl: item.snippet?.thumbnails?.maxres?.url ?? '',
          url: `https://www.youtube.com/watch?v=${id}`,
        }

        if (item.snippet?.description === 'This video is unavailable.') {
          partialVideo.isUnavailable = true
        }

        acc.push(partialVideo)
      })

      return acc
    },
    []
  )

  const videosListApiResponses = await genVideosList({yt, partialVideosData})
}
