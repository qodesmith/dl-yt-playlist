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
import {downloadAllVideos, getExistingVideoIds, getVideoMetadata} from './utils'

export default async function downloadYouTubePlaylist({
  playlistId,
  audioOnly,
  getFullData,
}: {
  playlistId: string
  audioOnly: boolean
  getFullData?: boolean
}) {
  const playlistName = await genPlaylistName(playlistId)
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
  })

  const totalTime = ((performance.now() - start) / 1000).toFixed(2)
  console.log(
    `✅ ${fetchCount} fetch calls completed in ${totalTime} seconds!\n`
  )

  // Create the needed directories to store the data.
  const subFolder = audioOnly ? 'audio' : 'video'
  const directories = [
    'data',
    `data/${playlistName}`,
    `data/${playlistName}/${subFolder}`,
  ]
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir)
  })

  /**
   * Save all the responses from the YouTube API to a file so we can inspect it if
   * we need to.
   */
  Bun.write(
    `./data/${playlistName}/responses.json`,
    JSON.stringify(fullData, null, 2)
  )

  // Create an array of objects containing the metadata we want on the videos.
  const videos = getVideoMetadata(fullData)

  // Write the video metadata to a new file.
  Bun.write(
    `./data/${playlistName}/videoMetadata.json`,
    JSON.stringify(videos, null, 2)
  )

  const existingIds = getExistingVideoIds({playlistName, audioOnly})

  await downloadAllVideos({
    videos,
    existingIds,
    maxLengthInSeconds: 60 * 11,
    playlistName,
    audioOnly,
  })
}
