/**
 * YouTube Data API Overview:
 * https://developers.google.com/youtube/v3/getting-started
 *
 * NPM package: @googleapis/youtube
 *
 * Node.js client:
 * https://github.com/googleapis/google-api-nodejs-client
 *
 * Docs:
 * https://googleapis.dev/nodejs/googleapis/latest/youtube/index.html
 */

import fs from 'node:fs'
import {genData, genPlaylistName} from './youtubeApiCalls'
import {
  ResultsMetadata,
  downloadAllThumbnails,
  downloadAllVideos,
  getExistingVideoIds,
  getResultsMetadata,
  getVideoMetadata,
} from './utils'
// https://googleapis.dev/nodejs/googleapis/latest/youtube/classes/Youtube.html
import google from '@googleapis/youtube'

export {getStats} from './getStats'
export {getDeactivatedVideos} from './getDeactivatedVideos'

/**
 * Download all the videos (or audio only) in a YouTube playlist!
 */
export async function downloadYouTubePlaylist({
  playlistId,
  apiKey,
  directory,
  audioOnly = false,
  getFullData = false,
  maxLengthInSeconds = Infinity,
  downloadData = true,
  downloadThumbnails = true,
}: {
  playlistId: string
  apiKey: string
  directory: string
  audioOnly?: boolean
  getFullData?: boolean
  maxLengthInSeconds?: number
  downloadData?: boolean
  downloadThumbnails?: boolean
}): Promise<ResultsMetadata> {
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
  const playlistName = await genPlaylistName({playlistId, yt})
  console.log('💻 Fetching playlist data from the YouTube API...')
  const start = performance.now()

  let fetchCount = 0
  const incrementFetchCount = (num: number) => {
    fetchCount += num
  }

  // Make the call to the YouTube API getting metadata for every video.
  const fullData = await genData({
    data: [],
    playlistId,
    maxResults: 50,
    incrementFetchCount,
    getFullData: !!getFullData,
    yt,
  })

  const totalTime = ((performance.now() - start) / 1000).toFixed(2)
  console.log(
    `✅ ${fetchCount} fetch calls completed in ${totalTime} seconds!\n`
  )

  // Create the needed directories to store the data.
  const contentFolder = audioOnly ? 'audio' : 'video'
  const directories = [
    directory,
    `${directory}/${playlistName}`,
    `${directory}/${playlistName}/${contentFolder}`,
    `${directory}/${playlistName}/thumbnails`,
  ]
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
  })

  /**
   * Save all the responses from the YouTube API to a file so we can inspect it
   * if we need to.
   */
  await Bun.write(
    `${directories[1]}/responses.json`,
    JSON.stringify(fullData, null, 2)
  )

  // Create an array of objects containing the metadata we want on the videos.
  const videos = getVideoMetadata(fullData)

  // Write the video metadata to a new file.
  await Bun.write(
    `${directories[1]}/videoMetadata.json`,
    JSON.stringify(videos, null, 2)
  )

  if (!downloadData && !downloadThumbnails) {
    console.log('\nOnly JSON files written!\n')
    return getResultsMetadata()
  }

  let videoResultsData = getResultsMetadata()
  if (downloadData) {
    const existingIds = getExistingVideoIds({
      playlistName,
      audioOnly,
      directory,
    })

    videoResultsData = await downloadAllVideos({
      videos,
      existingIds,
      maxLengthInSeconds,
      playlistName,
      audioOnly,
      directory,
    })
  }

  let finalResultsData = videoResultsData
  if (downloadThumbnails) {
    finalResultsData = await downloadAllThumbnails({
      fullData,
      directory: directories.at(-1) as string,
      resultsMetadata: finalResultsData,
    })
  }

  return finalResultsData
}
