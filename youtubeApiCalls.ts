import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

// https://googleapis.dev/nodejs/googleapis/latest/youtube/classes/Youtube.html
import * as google from '@googleapis/youtube'
import {getUnavailableVideos, getVideoIdsFromPlaylistResponse} from './utils'

const yt = google.youtube({version: 'v3', auth: process.env.API_KEY})

export type ResponseData = {
  playlistResponse: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  videosResponse: GaxiosResponse<youtube_v3.Schema$VideoListResponse>
}

type GenResponseDataArg = {
  playlistId: string
  pageToken?: string
  maxResults?: number
}

/**
 * Calls the YouTube API to get a playlists items, `maxResults` items at a time,
 * then calls a different endpoint to get metadata for each of those videos.
 *
 * Returns a single object containing responses for the playlist and videos.
 */
export async function genResponseData({
  playlistId,
  pageToken,
  maxResults = 50,
}: GenResponseDataArg): Promise<ResponseData> {
  // https://developers.google.com/youtube/v3/docs/playlistItems/list
  const playlistResponse = await yt.playlistItems.list({
    // Required params.
    playlistId,
    part: ['contentDetails', 'snippet'],

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
    // Required params.
    id: getVideoIdsFromPlaylistResponse(playlistResponse),
    part: ['snippet', 'contentDetails'],
    maxResults,
  })

  const responseData = {playlistResponse, videosResponse}
  getUnavailableVideos(responseData)

  return responseData
}

type GenFullResponseDataArg = {
  playlistId: string
  pageToken?: string
  maxResults: number
  data: ResponseData[]
}

/**
 * Will fetch metadata for all videos in a YouTube playlist.
 *
 * Returns an array of playlist and video API responses.
 */
export async function genFullResponseData({
  data,
  ...genResponseArg
}: GenFullResponseDataArg): Promise<ResponseData[]> {
  // Initiate a single request.
  const responseData = await genResponseData(genResponseArg)

  // Mutate the provided array by pushing the response.
  data.push(responseData)

  // Recursively fetch further responses.
  const {nextPageToken: pageToken} = responseData.playlistResponse.data
  if (pageToken) {
    return genFullResponseData({data, ...genResponseArg, pageToken})
  }

  return data
}
