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
  sanitizeTitle,
  getExistingIds,
  genIsOnline,
  getThumbnailsToBeDownloaded,
  chunkArray,
  downloadThumbnailFile,
  sanitizeTime,
  ResultsMetadata,
  Failure,
  getEmptyResults,
  arrayToIdObject,
} from './utils'
import {
  genPlaylistItems,
  genPlaylistName,
  genVideosList,
} from './youtubeApiCalls'
import google from '@googleapis/youtube'
import sanitizeFilename from 'sanitize-filename'

export {getStats, getDeactivatedVideos} from './publicUtils'

export async function downloadYouTubePlaylist({
  playlistId,
  apiKey,
  directory,
  includeFullData = false,
  maxDurationSeconds = Infinity,
  downloadType = 'audio',
  downloadThumbnails = false,
  saveRawResponses = false,
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

  /**
   * Optiona - default value `false`
   *
   * Boolean indicated whether to save the response data directly from the
   * YouTube API. This can be helpful for debugging. If set to `true`, two files
   * will be saved:
   *
   * - youtubePlaylistResponses.json
   * - youtubeVideoResponses.json
   */
  saveRawResponses?: boolean
}): Promise<ResultsMetadata> {
  const failures: Failure[] = []
  let totalVideosDownloaded = 0
  let totalThumbnailsDownloaded = 0

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
      console.log('This package is needed to download YouTube videos.')
      console.log(
        'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
      )

      return getEmptyResults()
    }
  } catch (e) {
    console.log('Could not find the `yt-dlp` package on this system.')
    console.log('This package is needed to download YouTube videos.')
    console.log(
      'Please head to https://github.com/yt-dlp/yt-dlp for download instructions.'
    )

    return getEmptyResults()
  }

  const isOnline = await genIsOnline()

  if (!isOnline) {
    console.log('🛜 Please connect to the internet and try again.')
    return getEmptyResults()
  }

  ////////////////////////////////////////////////////////////
  // STEP 2:                                                //
  // Call the YouTube API to get metadata for the playlist, //
  // with partial metadata for each video.                  //
  ////////////////////////////////////////////////////////////

  console.log('💻 Fetching playlist data from the YouTube API...')
  const start1 = performance.now()
  const yt = google.youtube({version: 'v3', auth: apiKey})
  const [playlistName, playlistItemsApiResponses] = await Promise.all([
    sanitizeFilename(await genPlaylistName({yt, playlistId})),
    await genPlaylistItems({
      yt,
      playlistId,
      includeFullData,
    }),
  ])

  const time1 = sanitizeTime(performance.now() - start1)
  const fetchCount1 = playlistItemsApiResponses.length + 1
  console.log(`✅ ${fetchCount1} fetch calls completed in ${time1}!`)

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
  // STEP 4:                                                        //
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

        const description = item.snippet?.description

        if (
          description === 'This video is unavailable.' ||
          description === 'This video is private.' ||
          title === 'Private video' ||
          title === 'Deleted video'
        ) {
          partialVideo.isUnavailable = true
        }

        acc.push(partialVideo)
      })

      return acc
    },
    []
  )

  /////////////////////////////////////////////////////////////////////////
  // STEP 5:                                                             //
  // Call the YouTube API and get the remaining metadata for each video, //
  // massaging it into a format we will use.                             //
  /////////////////////////////////////////////////////////////////////////

  console.log('\n💻 Fetching video data from the YouTube API...')

  const start2 = performance.now()
  const videosListApiResponses = await genVideosList({yt, partialVideosData})
  const partialVideosDataObj = arrayToIdObject(partialVideosData)
  const time2 = sanitizeTime(performance.now() - start2)
  const fetchCount2 = videosListApiResponses.length

  console.log(`✅ ${fetchCount2} fetch calls completed in ${time2}!`)

  const apiMetadata = videosListApiResponses.reduce<Video[]>(
    (acc, response) => {
      response.data.items?.forEach(item => {
        const partialVideo = partialVideosDataObj[item.id ?? '']

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

  ////////////////////////////////////////////////
  // STEP 6:                                    //
  // Optionally save the YouTube API responses. //
  ////////////////////////////////////////////////

  if (saveRawResponses) {
    await Promise.all([
      Bun.write(
        pathData.playlistResponses,
        JSON.stringify(playlistItemsApiResponses, null, 2)
      ),
      Bun.write(
        pathData.videoResponses,
        JSON.stringify(videosListApiResponses, null, 2)
      ),
    ])
  }

  //////////////////////////////////////////////////////////////////////////////
  // STEP 7:                                                                  //
  // Reconcile the existing metadata we may have with YouTube's metadata.     //
  // Videos no longer availble or that have become available will be updated. //
  // This reconciled data is saved locally as a json file.                    //
  //////////////////////////////////////////////////////////////////////////////

  console.log('\n💾 Reconciling the data & saving as `metadata.json`...')
  const start3 = performance.now()
  const existingData = await genExistingData(pathData.json)
  const newData = updateLocalVideosData({apiMetadata, existingData})
  await Bun.write(pathData.json, JSON.stringify(newData, null, 2))

  const time3 = (performance.now() - start3).toFixed(2)
  console.log(`✅ Data processed in ${time3} ms!`)

  if (downloadType === 'none' && !downloadThumbnails) {
    console.log('\n💾 Only `metadata.json` written, no files downloaded.')

    return {
      ...getEmptyResults(),
      failures,
      failureCount: failures.length,
      totalVideosDownloaded,
      totalThumbnailsDownloaded,
    }
  }

  /////////////////////////
  // STEP 8:             //
  // It's download time! //
  /////////////////////////

  const {audioIdSet, videoIdSet} = getExistingIds({
    downloadType,
    audioPath,
    videoPath,
  })

  const videosToDownload = newData.filter(
    ({durationInSeconds, id, isUnavailable}) => {
      const isValidDuration = (durationInSeconds ?? 0) <= maxDurationSeconds
      if (isUnavailable || !isValidDuration) return false

      switch (downloadType) {
        case 'audio':
          return !audioIdSet.has(id)
        case 'video':
          return !videoIdSet.has(id)
        case 'both':
          return !audioIdSet.has(id) && !videoIdSet.has(id)
      }
    }
  )
  const totalCount = videosToDownload.length

  if (downloadType !== 'none') {
    if (totalCount) {
      console.log('\n💻 Downloading Videos...')
      const start = performance.now()

      for (let i = 0; i < totalCount; i++) {
        const video = videosToDownload[i] as Video

        try {
          console.log(
            `(${i + 1} of ${totalCount}) Downloading ${video.title}...`
          )

          // Trigger the download.
          await downloadVideo({video, downloadType, audioPath, videoPath})
          totalVideosDownloaded++

          // Extract the audio file.
          if (downloadType === 'both') {
            try {
              await ffmpegCreateAudioFile({audioPath, videoPath, video})
            } catch (error) {
              failures.push({
                url: video.url,
                title: video.title,
                error,
                type: 'ffmpeg',
              })
            }
          }
        } catch (error) {
          failures.push({
            url: video.url,
            title: video.title,
            error,
            type: 'video',
          })
          console.log(`(${i + 1} of ${totalCount}) ❌ Failed to download`)
        }
      }

      const time = sanitizeTime(performance.now() - start)
      console.log(`✅ Videos downloaded in ${time}!`)
    } else {
      console.log('\n😎 All videos already accounted for!')
    }
  }

  if (downloadThumbnails) {
    const videosNeedingThumbnails = getThumbnailsToBeDownloaded({
      videos: videosToDownload,
      directory: pathData.thumbnails,
    })

    if (videosNeedingThumbnails.length) {
      const thumbnailChunks = chunkArray(videosNeedingThumbnails, 4)
      const start = performance.now()
      console.log('\n💻 Downloading thumbnails...')

      for (let i = 0; i < thumbnailChunks.length; i++) {
        const chunks = thumbnailChunks[i] as Video[]
        const count = `(${i + 1} of ${thumbnailChunks.length})`
        console.log(`${count} Downloading batch of thumbnails...`)

        await Promise.all(
          chunks.map(({url, id, title}) => {
            return downloadThumbnailFile({
              url,
              id,
              directory: pathData.thumbnails,
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

      const time = sanitizeTime(performance.now() - start)
      console.log(`✅ Thumbnails downloaded in ${time}!`)
    } else {
      console.log('\n😎 All thumbnails already accounted for!')
    }
  }

  return {
    ...getEmptyResults(),
    failures,
    failureCount: failures.length,
    totalVideosDownloaded,
    totalThumbnailsDownloaded,
  }
}
