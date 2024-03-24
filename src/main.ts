import {
  DownloadType,
  PartialVideo,
  createPathData,
  Video,
  parseISO8601Duration,
  genExistingData,
  updateLocalVideosData,
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
  getDefaultResults,
  arrayToIdObject,
  fileAndFolderNames,
  checkSystemDependencies,
  internalDownloadVideo,
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
  silent = false,
}: {
  // YouTube playlist id.
  playlistId: string

  // YouTube API key.
  apiKey: string

  // Full path to the directory where you want to save your data.
  directory: string

  /**
   * 'audio' - will only save videos as mp3 files and include json metadata
   * 'video' - will only save videos as mp4 files and include json metadata
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

  /**
   * Optional - default value `false`
   *
   * Boolean indicating wether to silence all internal console.log's. This will
   * not silence messages indicating missing `yt-dlp` or being offline.
   */
  silent?: boolean
}): Promise<ResultsMetadata> {
  const log = silent ? () => {} : console.log
  const failures: Failure[] = []
  let totalVideosDownloaded = 0
  let totalThumbnailsDownloaded = 0

  /////////////////////////////////////////////////////////////////////
  // STEP 1:                                                         //
  // Check if we have `yt-dlp` and `ffmpeg` installed on the system. //
  /////////////////////////////////////////////////////////////////////

  const missingDepsLoggers = checkSystemDependencies(downloadType)
  if (missingDepsLoggers.length) {
    missingDepsLoggers.forEach(fxn => fxn())
    return getDefaultResults()
  }

  const isOnline = await genIsOnline()

  if (!isOnline) {
    console.log('🛜 Please connect to the internet and try again.')
    return getDefaultResults()
  }

  ////////////////////////////////////////////////////////////
  // STEP 2:                                                //
  // Call the YouTube API to get metadata for the playlist, //
  // with partial metadata for each video.                  //
  ////////////////////////////////////////////////////////////

  log('💻 Fetching playlist data from the YouTube API...')
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
  log(`✅ ${fetchCount1} fetch calls completed in ${time1}!`)

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
  // This is partial video metadata.                                //
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

  log('\n💻 Fetching video data from the YouTube API...')

  const ids = partialVideosData.map(({id}) => id)
  const start2 = performance.now()
  const videosListApiResponses = await genVideosList({yt, ids})
  const time2 = sanitizeTime(performance.now() - start2)
  const fetchCount2 = videosListApiResponses.length
  const partialVideosDataObj = arrayToIdObject(partialVideosData)

  log(`✅ ${fetchCount2} fetch calls completed in ${time2}!`)

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

  log(`\n💾 Reconciling the data & saving as "${fileAndFolderNames.json}"...`)
  const start3 = performance.now()
  const existingData = await genExistingData(pathData.json)
  const newData = updateLocalVideosData({apiMetadata, existingData})
  await Bun.write(pathData.json, JSON.stringify(newData, null, 2))

  const time3 = (performance.now() - start3).toFixed(2)
  log(`✅ Data processed in ${time3} ms!`)

  if (downloadType === 'none' && !downloadThumbnails) {
    log('\n💾 Only `metadata.json` written, no files downloaded.')

    return {
      ...getDefaultResults(),
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
          return !audioIdSet.has(id) || !videoIdSet.has(id)
      }
    }
  )

  const totalCount = videosToDownload.length

  if (downloadType !== 'none') {
    if (totalCount) {
      log('\n💻 Downloading Videos...')
      const start = performance.now()

      for (let i = 0; i < totalCount; i++) {
        const video = videosToDownload[i] as Video

        try {
          log(`(${i + 1} of ${totalCount}) Downloading ${video.title}...`)

          // Trigger the download.
          await internalDownloadVideo({
            video,
            downloadType,
            audioPath,
            videoPath,
          })
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
          log(`(${i + 1} of ${totalCount}) ❌ Failed to download`)
        }
      }

      const time = sanitizeTime(performance.now() - start)
      log(`✅ Videos downloaded in ${time}!`)
    } else {
      log('\n😎 All videos already accounted for!')
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
      log('\n💻 Downloading thumbnails...')

      for (let i = 0; i < thumbnailChunks.length; i++) {
        const chunks = thumbnailChunks[i] as Video[]
        const count = `(${i + 1} of ${thumbnailChunks.length})`
        log(`${count} Downloading batch of thumbnails...`)

        await Promise.all(
          chunks.map(({thumbnaillUrl: url, id, title}) => {
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
                log(`❌ Failed to download thumbnail (${id}) - ${url}`)
              })
          })
        )
      }

      const time = sanitizeTime(performance.now() - start)
      log(`✅ Thumbnails downloaded in ${time}!`)
    } else {
      log('\n😎 All thumbnails already accounted for!')
    }
  }

  return {
    ...getDefaultResults(),
    failures,
    failureCount: failures.length,
    totalVideosDownloaded,
    totalThumbnailsDownloaded,
  }
}

export async function downloadVideo({
  id,
  apiKey,
  directory,
  downloadType = 'video',
  downloadThumbnail = false,
}: {
  // YouTube video id.
  id: string

  // YouTube API key.
  apiKey: string

  // Full path to the directory where you want to save your video.
  directory: string

  /**
   * 'audio' - will only save the video as an mp3 file
   * 'video' - will only save the video as an mp4 file
   * 'both' - will save the video as an mp3 and mp4 file
   */
  downloadType: 'audio' | 'video' | 'both'

  /**
   * Optional - default value `false`
   *
   * Boolean indicating whether to download the video thumbnail as jpg file.
   */
  downloadThumbnail?: boolean
}) {
  /////////////////////////////////////////////////////////////////////
  // STEP 1:                                                         //
  // Check if we have `yt-dlp` and `ffmpeg` installed on the system. //
  /////////////////////////////////////////////////////////////////////

  const missingDepsLoggers = checkSystemDependencies(downloadType)
  if (missingDepsLoggers.length) {
    missingDepsLoggers.forEach(fxn => fxn())
    return getDefaultResults()
  }

  const isOnline = await genIsOnline()

  if (!isOnline) {
    console.log('🛜 Please connect to the internet and try again.')
    return getDefaultResults()
  }

  const yt = google.youtube({version: 'v3', auth: apiKey})
  const videosListApiResponses = await genVideosList({yt, ids: [id]})
  const videoData = videosListApiResponses[0]?.data.items?.[0]

  if (!videoData) {
    throw new Error(`No video found for ${id}`)
  }

  const title = sanitizeFilename(videoData.snippet?.title ?? '')
  const thumbnaillUrl = videoData.snippet?.thumbnails?.maxres?.url ?? ''
  const video = {url: `https://www.youtube.com/watch?v=${id}`, title}

  internalDownloadVideo({
    video,
    videoPath: directory,
    audioPath: directory,
    downloadType,
  }).catch(error => {
    console.log(`❌ Failed to download ${id}:`, error)
  })

  if (downloadThumbnail) {
    const res = await fetch(thumbnaillUrl, {
      method: 'GET',
      headers: {'Content-Type': 'image/jpeg'},
    })

    if (!res.ok) {
      throw new Error('Network response was not ok')
    }

    return Bun.write(`${directory}/${title} [${id}].jpg`, res)
  }
}
