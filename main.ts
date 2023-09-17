/**
 * YouTube Data API Overview:
 * https://developers.google.com/youtube/v3/getting-started
 *
 * My Google Service Details:
 * https://console.cloud.google.com/apis/api/youtube.googleapis.com/metrics?project=qodesmith-stuffs
 *
 * NPM package: @googleapis/youtube
 *
 * Node.js client:
 * https://github.com/googleapis/google-api-nodejs-client
 *
 * Docs:
 * https://googleapis.dev/nodejs/googleapis/latest/youtube/index.html
 */

import * as fs from 'node:fs'
import {genFullResponseData} from './youtubeApiCalls'
import {getVideoDataFromResponse} from './utils'

// @ts-expect-error - Bun runs top-level await just fine.
const responses = await genFullResponseData({
  playlistId: process.env.PLAYLIST_ID,
  maxResults: 50,
  data: [],
})

if (!fs.existsSync('data')) fs.mkdirSync('data')
Bun.write(
  `./data/${process.env.PLAYLIST_ID}_responses.json`,
  JSON.stringify(responses, null, 2)
)
Bun.write(
  `./data/${process.env.PLAYLIST_ID}_videos.json`,
  JSON.stringify(
    responses.flatMap(({videosResponse}) =>
      getVideoDataFromResponse(videosResponse)
    ),
    null,
    2
  )
)
