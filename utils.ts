import {youtube_v3} from '@googleapis/youtube'
import {ResponseData} from './youtubeApiCalls'

/**
 * Returns an array of video ids given a response from the playlist endpoint.
 */
export function getVideoIdsFromPlaylistResponse(playlistResponse: {
  data: youtube_v3.Schema$PlaylistItemListResponse
}): string[] {
  if (!playlistResponse.data.items) {
    throw new Error('Missing playlistResponse.data.items')
  }

  return playlistResponse.data.items.map(({contentDetails}) => {
    if (!contentDetails?.videoId) {
      throw new Error('contentDetails or videoId missing from playlist item')
    }

    return contentDetails.videoId
  })
}

export function getUnavailableVideoPlaylistItemIds({
  playlistResponse,
  videosResponse,
}: ResponseData): string[] | undefined {
  const playlistItems = playlistResponse.data.items ?? []
  const videoItems = videosResponse.data.items ?? []
  const videoIdSet = new Set(videoItems.map(({id}) => id))
  const missingPlaylistVideos = playlistItems.filter(
    ({contentDetails}) => !videoIdSet.has(contentDetails?.videoId)
  )

  if (missingPlaylistVideos.length) {
    return missingPlaylistVideos.reduce((acc: string[], {id}) => {
      if (id) acc.push(id)
      return acc
    }, [])
  }
}

type Video = {
  id: string
  title: string
  channel: string
  publishedAt: string
  url: string
  lengthInSeconds: number
}

/**
 * Metadata we want:
 * - channel - `item.snippet.channelTitle`
 * - title - `item.snippet.title`
 * - URL (we can construct this)
 * - length - `item.contentDetails.duration` - the format is IS0 8601 duration
 * - date - `item.snippet.publishedAt`
 * - ❌ audio bitrate - not available to non-video owners
 */
export function getVideoDataFromResponse(response: {
  data: youtube_v3.Schema$VideoListResponse
}): Video[] {
  return (response.data.items ?? []).reduce((acc: Video[], item) => {
    const {id} = item
    const {channelTitle: channel, title, publishedAt} = item.snippet ?? {}
    const url = `https://www.youtube.com/watch?v=${id}`
    const lengthInSeconds = parseISO8601Duration(item.contentDetails?.duration)

    if (lengthInSeconds !== null && lengthInSeconds > 60 * 6) {
      console.log('LONG VIDEO:', {
        id,
        title,
        channel,
        publishedAt,
        url,
        lengthInSeconds,
      })
    }

    if (!id || !title || !channel || !publishedAt || lengthInSeconds === null) {
      throw new Error('Property missing from video')
    }

    acc.push({id, title, channel, publishedAt, url, lengthInSeconds})
    return acc
  }, [])
}

function parseISO8601Duration(durationString: string | undefined | null) {
  if (!durationString) return null

  const regex =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/
  const matches = durationString.match(regex) ?? []
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
