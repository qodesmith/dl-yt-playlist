import type {youtube_v3} from '@googleapis/youtube'

/**
 * Calls the YouTube "Playlists: list" endpoint to get the playlist name.
 *
 * https://developers.google.com/youtube/v3/docs/playlists/list
 */
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
