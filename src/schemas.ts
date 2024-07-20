import {object, string, number, optional, array, minLength} from 'valibot'

/**
 * This schema is used to parse the response from the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems).
 * Optional properties are marked as so to accommodate videos no longer
 * available.
 */
export const PlaylistItemSchema = object({
  id: string(),
  snippet: object({
    resourceId: object({
      videoId: string(), // id
    }),
    title: string(),
    description: string(),
    videoOwnerChannelId: optional(string(), ''), // channelId
    videoOwnerChannelTitle: optional(string(), ''), // channelName
    publishedAt: string(), // dateAddedToPlaylist

    // thumbnailUrl
    thumbnails: object({
      maxres: optional(object({url: string()})),
      standard: optional(object({url: string()})),
      high: optional(object({url: string()})),
      medium: optional(object({url: string()})),
      default: optional(object({url: string()})),
    }),
  }),
  contentDetails: object({
    videoPublishedAt: optional(string(), ''), // dateCreated
  }),
})

/**
 * This is used to validate the response from the YouTube
 * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
 */
export const VideosListItemSchema = object({
  id: string(),
  contentDetails: object({
    duration: string(),
  }),
})

/**
 * `yt-dlp` provides it's own metadata for videos. While this project relies
 * mainly on the Youtube APIs for metadata, we use metadata from `yt-dlp` for
 * individual videos downloaded with `downloadVideo`. File extensions are also
 * parsed from the `yt-dlp` metadata.
 */
export const YtDlpJsonSchema = object({
  id: string(),
  title: string(),
  description: string(),
  duration: number(),
  channel_url: string(),
  channel_id: string(),
  upload_date: string(), // e.x. 20240221 (i.e. 2/21/2024)
  channel: string(), // Channel name.
  ext: string(), // Video file extension.
  requested_downloads: array(
    object({
      ext: string(), // Audio file extension.
    }),
    [minLength(1)]
  ),
})
