import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

// https://googleapis.dev/nodejs/googleapis/latest/youtube/classes/Youtube.html
import google from '@googleapis/youtube'
import {
  getUnavailableVideoPlaylistItemIds,
  getVideoIdsFromPlaylistResponse,
} from './utils'

const yt = google.youtube({version: 'v3', auth: process.env.API_KEY})

type SinglePageDataInput = {
  playlistId: string
  pageToken?: string
  maxResults?: number
  incrementFetchCount: (num: number) => void
}

export type PageData = {
  playlistResponse: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  videosResponse: GaxiosResponse<youtube_v3.Schema$VideoListResponse>
  unavailableItemIds: string[]
}

export async function genPlaylistName(playlistId: string) {
  const response = await yt.playlists.list({
    id: [playlistId],
    part: ['snippet'],
  })

  const playlistName = response.data?.items?.[0].snippet?.title
  if (!playlistName) throw new Error('Failed to fetch playlist name')

  return playlistName
}

/**
 * - Fetches a single page of playlist items from a YouTube playlist.
 * - Fetches video metadata for each list item.
 * - Calculates which videos are no longer available.
 *
 * Returns an object containing:
 * ```javascript
 * {playlistResponse, videosResponse, unavailableItemIds}
 * ```
 */
async function genSinglePageData({
  playlistId,
  pageToken,
  incrementFetchCount,
  maxResults = 50,
}: SinglePageDataInput): Promise<PageData> {
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

  incrementFetchCount(2)

  const unavailableItemIds = getUnavailableVideoPlaylistItemIds({
    playlistResponse,
    videosResponse,
  })

  return {playlistResponse, videosResponse, unavailableItemIds}
}

type PageDataInput = SinglePageDataInput & {
  data: PageData[]
  incrementFetchCount: (nun: number) => void
  getFullData: boolean
}

/**
 * - Fetches all pages of playlist items from a YouTube playlist.
 * - Calls `genSinglePageData` recursively to do so.
 *
 * Returns an array of resolved calls to `genSinglePageData`
 */
export async function genData({
  data,
  playlistId,
  pageToken,
  incrementFetchCount,
  getFullData,
  maxResults = 50,
}: PageDataInput) {
  // Initiate a single request.
  const pageData = await genSinglePageData({
    playlistId,
    pageToken,
    maxResults,
    incrementFetchCount,
  })

  // Mutate the provided array by pushing the response.
  data.push(pageData)

  // Recursively fetch further responses.
  const {nextPageToken} = pageData.playlistResponse.data
  if (getFullData && nextPageToken) {
    return genData({
      data,
      playlistId,
      pageToken: nextPageToken,
      maxResults,
      incrementFetchCount,
      getFullData,
    })
  }

  return data
}
