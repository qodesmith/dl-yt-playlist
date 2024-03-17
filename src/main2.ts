import {
  DownloadType,
  PartialVideo,
  createPathData,
  Video,
  parseISO8601Duration,
  genExistingData,
  updateLocalVideosData,
  downloadVideo,
  ffmpegCreateAudioFile,
  downloadAllThumbnails,
  sanitizeTitle,
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
  maxDurationSeconds = Infinity,
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
  maxDurationSeconds?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating whether to download the video thumbnails as jpg files.
   */
  downloadThumbnails?: boolean
}) {
  ////////////////////////////////////////////////////////
  // STEP 1:                                            //
  // Check if we have `yt-dlp` installed on the system. //
  ////////////////////////////////////////////////////////

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
    console.log('This package is needed to download YouTube videos.')
    console.log(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )
    process.exit(1)
  }

  ////////////////////////////////////////////////////////////
  // STEP 2:                                                //
  // Call the YouTube API to get metadata for the playlist, //
  // with partial metadata for each video.                  //
  ////////////////////////////////////////////////////////////

  const yt = google.youtube({version: 'v3', auth: apiKey})
  const [playlistName, playlistItemsApiResponses] = await Promise.all([
    await genPlaylistName({yt, playlistId}),
    await genPlaylistItems({
      yt,
      playlistId,
      includeFullData,
    }),
  ])

  ///////////////////////////////////////////////////////////////////////
  // STEP 3:                                                           //
  // Create the folder and file names used based on the playlist name. //
  ///////////////////////////////////////////////////////////////////////

  const pathData = createPathData({
    directory,
    playlistName,
    downloadType,
    downloadThumbnails,
  })
  const audioPath = pathData.audio
  const videoPath = pathData.video

  ////////////////////////////////////////////////////////////////////
  // STEP 3:                                                        //
  // Massage YouTube's playlist metadata into a format we will use. //
  ////////////////////////////////////////////////////////////////////

  const partialVideosData = playlistItemsApiResponses.reduce<PartialVideo[]>(
    (acc, response) => {
      response.data.items?.forEach(item => {
        const id = item.snippet?.resourceId?.videoId ?? ''
        const title = sanitizeTitle(item.snippet?.title ?? '')
        const partialVideo: PartialVideo = {
          id,
          title,
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

  /////////////////////////////////////////////////////////////////////////
  // STEP 3:                                                             //
  // Call the YouTube API and get the remaining metadata for each video, //
  // massaging it into a format we will use.                             //
  /////////////////////////////////////////////////////////////////////////

  const videosListApiResponses = await genVideosList({yt, partialVideosData})
  const apiMetadata = videosListApiResponses.reduce<Video[]>(
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

  //////////////////////////////////////////////////////////////////////////////
  // STEP 4:                                                                  //
  // Reconcile the existing metadata we may have with YouTube's metadata.     //
  // Videos no longer availble or that have become available will be updated. //
  // This reconciled data is saved locally as a json file.                    //
  //////////////////////////////////////////////////////////////////////////////

  const existingData = await genExistingData(pathData.json)
  const newData = updateLocalVideosData({apiMetadata, existingData})
  await Bun.write(pathData.json, JSON.stringify(newData, null, 2))

  if (downloadType === 'none' && !downloadThumbnails) {
    return console.log('Only `metadata.json` written, no files downloaded.')
  }

  /////////////////////////
  // STEP 5:             //
  // It's download time! //
  /////////////////////////

  const videosToDownload = newData
    .filter(({durationInSeconds}) => {
      return (durationInSeconds ?? 0) <= maxDurationSeconds
    })
    .slice(0, 2) // REMOVE ME
  const totalCount = videosToDownload.length

  if (downloadType !== 'none') {
    for (let i = 0; i < totalCount; i++) {
      const count = i + 1
      const video = videosToDownload[i] as Video

      try {
        console.log(`${count} ${video.title} - downloading...`)

        // Trigger the download.
        await downloadVideo({video, downloadType, audioPath, videoPath})

        // Extract the audio file.
        if (downloadType === 'both') {
          await ffmpegCreateAudioFile({audioPath, videoPath, video})
        }
      } catch (e) {
        console.log(e)
      }
    }
  }

  console.log('\n Downloading thumbnails...')
  await downloadAllThumbnails({
    videos: videosToDownload,
    directory: pathData.thumbnails,
  })
  console.log('Complete!')
}
