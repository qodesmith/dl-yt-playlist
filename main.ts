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

import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'
import * as fs from 'node:fs'

// https://googleapis.dev/nodejs/googleapis/latest/youtube/classes/Youtube.html
import * as google from '@googleapis/youtube'
const yt = google.youtube({version: 'v3', auth: process.env.API_KEY})

type ApiData = {
  playlistResponse: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  videosResponse: GaxiosResponse<youtube_v3.Schema$VideoListResponse>
}[]

type Video = {
  id: string
  title: string
  channel: string
  publishedAt: string
  url: string
  lengthInSeconds: number
}

/**
 * Calls the YouTube API to get a playlists items, `maxResults` items at a time,
 * then calls a different endpoint to get metadata on each of those videos. It
 * will call itself recursively until all videos in the playlist have been
 * fetched.
 *
 * Returns an array of playlist and video API responses.
 */
async function genResponses({
  playlistId,
  data = [],
  pageToken,
  maxResults = 50,
}: {
  playlistId: string
  data?: ApiData
  pageToken?: string
  maxResults?: number
}): Promise<ApiData> {
  // https://developers.google.com/youtube/v3/docs/playlistItems/list
  const playlistResponse = await yt.playlistItems.list({
    // Required params.
    playlistId,
    part: ['contentDetails'],

    // Optional params.
    pageToken,
    maxResults,
  })

  /**
   * https://developers.google.com/youtube/v3/docs/videos/list
   *
   * Metadata we want:
   * - channel name - `item.snippet.channelTitle`
   * - title - `item.snippet.title`
   * - URL (we can construct this)
   * - length - `item.contentDetails.duration` - the format is IS0 8601 duration
   * - audio bitrate - not available to non-video owners
   */
  const videosResponse = await yt.videos.list({
    // Required [params.
    id: getVideoIdsFromPlaylistResponse(playlistResponse),
    part: ['snippet', 'contentDetails'],
    maxResults,
  })

  const playlistItemsLength = playlistResponse.data.items.length
  const videoItemsLength = videosResponse.data.items.length

  // if (playlistItemsLength !== videoItemsLength) {
  //   throw new Error(
  //     `Length mistmatch - playlist items: ${playlistItemsLength}, videos: ${videoItemsLength}`
  //   )
  // }

  data.push({playlistResponse, videosResponse})

  if (playlistResponse.data.nextPageToken) {
    return genResponses({
      playlistId,
      data,
      pageToken: playlistResponse.data.nextPageToken,
    })
  }

  return data
}

// @ts-expect-error - Bun runs top-level await just fine.
const responses = await genResponses({playlistId: process.env.PLAYLIST_ID})

console.log(responses.length)

if (!fs.existsSync('data')) fs.mkdirSync('data')
Bun.write('./data/response.json', JSON.stringify(responses, null, 2))
Bun.write(
  './data/videos.json',
  JSON.stringify(
    responses.flatMap(({videosResponse}) =>
      getVideoDataFromResponse(videosResponse)
    ),
    null,
    2
  )
)

/**
 * Metadata we want:
 * - channel - `item.snippet.channelTitle`
 * - title - `item.snippet.title`
 * - URL (we can construct this)
 * - length - `item.contentDetails.duration` - the format is IS0 8601 duration
 * - date - `item.snippet.publishedAt`
 * - ❌ audio bitrate - not available to non-video owners
 */
function getVideoDataFromResponse(response: {
  data: youtube_v3.Schema$VideoListResponse
}): Video[] {
  return response.data.items.reduce((acc: Video[], item) => {
    const {id} = item
    const {channelTitle: channel, title, publishedAt} = item.snippet
    const url = `https://www.youtube.com/watch?v=${id}`
    const lengthInSeconds = parseISO8601Duration(item.contentDetails.duration)
    const video = {id, title, channel, publishedAt, url, lengthInSeconds}

    if (lengthInSeconds > 60 * 6) {
      console.log('LONG VIDEO:', video)
    }

    acc.push(video)
    return acc
  }, [])
}

/**
 * Returns an array of video ids given a response from the playlist endpoint.
 */
function getVideoIdsFromPlaylistResponse(playlistResponse: {
  data: youtube_v3.Schema$PlaylistItemListResponse
}): string[] {
  return playlistResponse.data.items.map(({contentDetails}) => {
    return contentDetails.videoId
  })
}

function parseISO8601Duration(durationString) {
  const regex =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/
  const matches = durationString.match(regex)
  const years = matches[1] ? parseInt(matches[1]) : 0
  const months = matches[2] ? parseInt(matches[2]) : 0
  const weeks = matches[3] ? parseInt(matches[3]) : 0
  const days = matches[4] ? parseInt(matches[4]) : 0
  const hours = matches[5] ? parseInt(matches[5]) : 0
  const minutes = matches[6] ? parseInt(matches[6]) : 0
  const seconds = matches[7] ? parseFloat(matches[7]) : 0
  const totalSeconds =
    years * 31536000 +
    months * 2592000 +
    weeks * 604800 +
    days * 86400 +
    hours * 3600 +
    minutes * 60 +
    seconds

  return totalSeconds
}
