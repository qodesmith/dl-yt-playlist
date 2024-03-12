import {
  DownloadType,
  PartialVideo,
  createPathData,
  Video,
  parseISO8601Duration,
  genExistingVideosData,
  updateLocalVideosData,
} from './utils2'
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
  includeFullData = false,
  maxSecondsDuration = Infinity,
  downloadType = 'audio',
  downloadThumbnails = false,
}: {
  // YouTube playlist id.
  playlistId: string

  // YouTube API key.
  apiKey: string

  // Full path to the directory you want to save your data.
  directory: string

  /**
   * 'audio' - will only save videos as mp3 files and include json metadata
   * 'video' - will only save videos as mp4 files and incluide json metadata
   * 'both' - will save videos as mp3 and mp4 files and include json metadata
   * 'none' - will only save json metadata
   */
  downloadType: DownloadType

  /**
   * Optional - default value `false`
   *
   * Boolean indicating if the full playlist data get's fetched or not.
   *
   * `true`  - download all items in the playlist
   * `false` - download only the 50 most recent items in the playlist
   */
  includeFullData?: boolean

  /**
   * Optional - default value `Infinity`
   *
   * The maximum duration a playlist item can be to be downloaded.
   */
  maxSecondsDuration?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating whether to download the video thumbnails as jpg files.
   */
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
  const [playlistName, playlistItemsApiResponses] = await Promise.all([
    await genPlaylistName({yt, playlistId}),
    await genPlaylistItems({
      yt,
      playlistId,
      includeFullData,
    }),
  ])

  const pathData = createPathData({
    directory,
    playlistName,
    downloadType,
    downloadThumbnails,
  })

  const partialVideosData = playlistItemsApiResponses.reduce<PartialVideo[]>(
    (acc, response) => {
      response.data.items?.forEach(item => {
        const id = item.snippet?.resourceId?.videoId ?? ''
        const title = item.snippet?.title ?? ''
        const partialVideo: PartialVideo = {
          id,
          title,
          channelId: item.snippet?.videoOwnerChannelId ?? '',
          channelName: item.snippet?.videoOwnerChannelTitle ?? '',
          dateAddedToPlaylist: item.snippet?.publishedAt ?? '',
          thumbnaillUrl: item.snippet?.thumbnails?.maxres?.url ?? '',
          thumbnailPath: `${pathData.thumbnails}/${id}.jpg`,
          url: `https://www.youtube.com/watch?v=${id}`,

          /**
           * The presence of these paths in the json does not indicate that
           * these files have been downloaded.
           */
          mp3Path: `${pathData.audio}/${title} [${id}].mp3`,
          mp4Path: `${pathData.video}/${title} [${id}].mp4`,
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

  const videosData = videosListApiResponses.reduce<Video[]>(
    (acc, response, i) => {
      response.data.items?.forEach((item, j) => {
        const partialIdx = i * 50 + j
        const partialVideo = partialVideosData[partialIdx]

        // This should never happen, but just in case.
        if (!partialVideo) throw new Error('No partial video found')

        acc.push({
          ...partialVideo,
          dateCreated: item.snippet?.publishedAt ?? '',
          durationInSeconds: parseISO8601Duration(
            item.contentDetails?.duration
          ),
        })
      })

      return acc
    },
    []
  )

  const {existingAudioData, existingVideoData} = await genExistingVideosData({
    downloadType,
    audioJsonPath: pathData.audioJson,
    videoJsonPath: pathData.videoJson,
  })

  const {newAudioData, newVideoData} = updateLocalVideosData({
    videosData,
    existingAudioData,
    existingVideoData,
  })

  if (newAudioData) {
    await Bun.write(pathData.audioJson, JSON.stringify(newAudioData, null, 2))
  }

  if (newVideoData) {
    await Bun.write(pathData.videoJson, JSON.stringify(newVideoData, null, 2))
  }
}
