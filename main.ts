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
import {genFullData} from './youtubeApiCalls'
import {getVideoMetadata} from './utils'

const {PLAYLIST_ID} = process.env
if (!PLAYLIST_ID) throw new Error('Missing PLAYLIST_ID env variable.')

const fullData = await genFullData({
  data: [],
  playlistId: PLAYLIST_ID,
  maxResults: 50,
})

if (!fs.existsSync('data')) fs.mkdirSync('data')
Bun.write(
  `./data/${process.env.PLAYLIST_ID}_responses.json`,
  JSON.stringify(fullData, null, 2)
)
Bun.write(
  `./data/${process.env.PLAYLIST_ID}_videos.json`,
  JSON.stringify(getVideoMetadata(fullData), null, 2)
)
