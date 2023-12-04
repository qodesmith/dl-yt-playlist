import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

import {
  getUnavailableVideoPlaylistItemIds,
  getVideoIdsAndDatesAddedFromPlaylistResponse,
} from './utils'

type SinglePageDataInput = {
  playlistId: string
  pageToken?: string
  maxResults?: number
  incrementFetchCount: (num: number) => void
  yt: youtube_v3.Youtube
}

export type PageData = {
  playlistResponse: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>
  videosResponse: GaxiosResponse<youtube_v3.Schema$VideoListResponse>
  unavailableItemIds: string[]
  videoIdsAndDates: Record<string, string>
}

export async function genPlaylistName({
  playlistId,
  yt,
}: {
  playlistId: string
  yt: youtube_v3.Youtube
}) {
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
  yt,
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

  const videoIdsAndDates =
    getVideoIdsAndDatesAddedFromPlaylistResponse(playlistResponse)

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
    id: Object.keys(videoIdsAndDates),
    part: ['snippet', 'contentDetails'],
    maxResults,
  })

  incrementFetchCount(2)

  const unavailableItemIds = getUnavailableVideoPlaylistItemIds({
    playlistResponse,
    videosResponse,
  })

  return {
    playlistResponse,
    videosResponse,
    unavailableItemIds,
    videoIdsAndDates,
  }
}

type PageDataInput = SinglePageDataInput & {
  data: PageData[]
  incrementFetchCount: (nun: number) => void
  getFullData: boolean
  yt: youtube_v3.Youtube
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
  yt,
  maxResults = 50,
}: PageDataInput) {
  // Initiate a single request.
  const pageData = await genSinglePageData({
    playlistId,
    pageToken,
    maxResults,
    incrementFetchCount,
    yt,
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
      yt,
    })
  }

  return data
}
