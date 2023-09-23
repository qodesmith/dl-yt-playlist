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
import {genFullData, genPlaylistName} from './youtubeApiCalls'
import {downloadAllVideos, getExistingVideoIds, getVideoMetadata} from './utils'
import minimist from 'minimist'

const audioOnly = minimist(Bun.argv, {boolean: ['audioOnly']}).audioOnly
const {PLAYLIST_ID} = process.env
if (!PLAYLIST_ID) throw new Error('Missing PLAYLIST_ID env variable.')

const playlistName = await genPlaylistName(PLAYLIST_ID)

console.log('💻 Fetching playlist data from the YouTube API...')
const start = performance.now()

// Make the call to the YouTube API getting metadata for every video.
const fullData = await genFullData({
  data: [],
  playlistId: PLAYLIST_ID,
  maxResults: 50,
})

const totalTime = ((performance.now() - start) / 1000).toFixed()
console.log(`✅ Fetch completed in ${totalTime} seconds!\n`)

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
