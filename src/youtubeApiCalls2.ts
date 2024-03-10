import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'
import {PartialVideo, chunkArray} from './utils2'

/**
 * Calls the YouTube "Playlists: list" endpoint to get the playlist name.
 *
 * https://developers.google.com/youtube/v3/docs/playlists/list
 */
export async function genPlaylistName({
  yt,
  playlistId,
}: {
  yt: youtube_v3.Youtube
  playlistId: string
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
 * Calls the YouTube "PlaylistItems: list" endpoint to get the list of videos.
 * If `fullData: true`, this function will call itself iteratively with the
 * `nextPageToken` returned from the API reponse.
 *
 * https://developers.google.com/youtube/v3/docs/playlistItems/list
 *
 * Data is returned in the `items` field:
 *
 * https://developers.google.com/youtube/v3/docs/playlistItems#resource
 */
export async function genPlaylistItems({
  yt,
  playlistId,
  pageToken,
  maxResults = 50, // 50 is YouTube's maximum value.
  fullData,
  responses = [],
}: {
  yt: youtube_v3.Youtube
  playlistId: string
  pageToken?: string
  maxResults?: number
  fullData?: boolean
  responses?: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>[]
}): Promise<GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>[]> {
  /**
   * The `part` param will determine what data is returned in the reponse.
   *
   * Some details of the response:
   *
   * `snippet.publishedAt` - The date and time that the item was added to the playlist.
   * We will get the date and time the video was published on YouTube in a
   * different API call.
   *
   * `snippet.resourceId.videoId` - The video id used in the YouTube URL (the short id).
   *
   * `snippet.videoOwnerChannelTitle` - The video's channel name.
   *
   * `snippet.videoOwnerChannelId` - The video's channel id.
   */
  const response = await yt.playlistItems.list({
    // Required params.
    playlistId,
    part: ['snippet'],

    // Optional params.
    pageToken,
    maxResults,
  })

  const {nextPageToken} = response.data
  responses.push(response)

  if (fullData) {
    return nextPageToken
      ? genPlaylistItems({
          yt,
          playlistId,
          pageToken: nextPageToken,
          maxResults,
          fullData,
          responses,
        })
      : responses
  }

  return responses
}

/**
 * Calls the YouTube "Videos: list" endpoint to get metadata for a list of
 * videos given their ids.
 *
 * https://developers.google.com/youtube/v3/docs/videos/list
 */
export async function genVideosList({
  yt,
  partialVideosData,
}: {
  yt: youtube_v3.Youtube
  partialVideosData: PartialVideo[]
}): Promise<GaxiosResponse<youtube_v3.Schema$VideoListResponse>[]> {
  const chunksOf50 = chunkArray(partialVideosData, 50)
  const responses: GaxiosResponse<youtube_v3.Schema$VideoListResponse>[] = []

  for (const chunk of chunksOf50) {
    const response = await yt.videos.list({
      // Required params.
      id: chunk.map(item => item.id),
      part: ['snippet', 'contentDetails'],
      maxResults: 50,
    })

    responses.push(response)
  }

  return responses
}
