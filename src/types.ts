import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

import {InferInput, InferIssue} from 'valibot'

import {
  PlaylistItemSchema,
  VideoSchema,
  VideosListItemSchema,
  YtDlpJsonSchema,
} from './schemas'

export type Video = InferInput<typeof VideoSchema>

export type PartialVideo = Omit<
  Video,
  'durationInSeconds' | 'audioFileExtension' | 'videoFileExtension' | 'lufs'
>

export type PartialVideoWithDuration = PartialVideo &
  Pick<Video, 'durationInSeconds'>

export type Failure = {date: number} & (
  | {
      type: 'Bun.write'
      file: string
      error: Record<string, unknown>
    }
  | {
      type: 'schemaParse'
      schemaName: 'PlaylistItemSchema'
      issues: InferIssue<typeof PlaylistItemSchema>[]
    }
  | {
      type: 'schemaParse'
      schemaName: 'VideosListItemSchema'
      issues: InferIssue<typeof VideosListItemSchema>[]
    }
  | {
      type: 'schemaParse'
      schemaName: 'YtDlpJsonSchema'
      issues: InferIssue<typeof YtDlpJsonSchema>[]
    }
  | {
      type: 'videosListApi'
      error: Record<string, unknown>
      ids: string[] | undefined
    }
  | {
      type: 'partialVideoNotFound'
      id: string
    }
  | {
      type: 'ytdlpFailure'
      url: string
      template: string
      stderr: string
    }
  | {
      type: 'thumbnailDownload'
      url: string
      status: number
      statusText: string
    }
  | {
      type: 'thumbnailUrlNotAvailable'
      urls: string[]
      videoId: string
    }
  | {
      type: 'lufs'
      filePath: string
      errorMessage: string
    }
  | {
      type: 'generic'
      error: unknown
      context: string
    }
)

/**
 * A function that takes in a list of ids (representing which videos we have
 * metadata for from the Playlist API) and returns a filtered list of ids
 * representing which videos to download from the Videos API.
 */
export type GetIdsForDownload = (ids: string[]) => string[] | Promise<string[]>

export type DownloadOptions =
  | {
      downloadType: 'audio'
      audioFormat: string
      directory: string

      /**
       * A function that takes in a list of ids (representing which videos we
       * have metadata for from the Playlist API) and returns a filtered list of
       * ids representing which videos to download from the Videos API.
       *
       * This function is run _after_ the call for playlist data and _before_
       * the call for video data.
       */
      getIdsForDownload: GetIdsForDownload
      downloadThumbnails: boolean
    }
  | {
      downloadType: 'video'
      videoFormat: string
      directory: string

      /**
       * A function that takes in a list of ids (representing which videos we
       * have metadata for from the Playlist API) and returns a filtered list of
       * ids representing which videos to download from the Videos API.
       *
       * This function is run _after_ the call for playlist data and _before_
       * the call for video data.
       */
      getIdsForDownload: GetIdsForDownload
      downloadThumbnails: boolean
    }
  | {
      downloadType: 'both'
      audioFormat: string
      videoFormat: string
      directory: string

      /**
       * A function that takes in a list of ids (representing which videos we
       * have metadata for from the Playlist API) and returns a filtered list of
       * ids representing which videos to download from the Videos API.
       *
       * This function is run _after_ the call for playlist data and _before_
       * the call for video data.
       */
      getIdsForDownload: GetIdsForDownload
      downloadThumbnails: boolean
    }
  | {
      downloadType: 'none'
    }

export type DownloadYouTubePlaylistInput = {
  playlistId: string
  youTubeApiKey: string
  maxDurationSeconds?: number
  mostRecentItemsCount?: number
  silent?: boolean
  timeZone?: string
  maxConcurrentYouTubeCalls?: number
  maxConcurrentYtdlpCalls?: number
} & DownloadOptions

export type DownloadYouTubePlaylistOutput = {
  /**
   * The raw responses from the YouTube
   * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems).
   */
  playlistItemListResponses: GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>[]

  /**
   * The raw responses from the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   */
  videoListResponses: (GaxiosResponse<youtube_v3.Schema$VideoListResponse> | null)[]

  /**
   * Metadata for videos that were downloaded.
   */
  videosDownloaded: Video[]

  // TODO - check if this is only for videos we attempted to download, i.e.
  // videos that the getIdsForDownload included.
  /**
   * Metadata for videos that are no longer available due to either being
   * deleted or made private.
   */
  unavailableVideos: Video[]

  /**
   * Various failures incurred along the way.
   */
  failures: Failure[]

  /**
   * An object detailing the number of downloads for `audio`, `video`, and
   * `thumbnails`.
   */
  downloadCount: DownloadCount

  /**
   * The number of times the YouTube API was hit.
   */
  youTubeFetchCount: number
}

export type DownloadCount = {audio: number; video: number; thumbnail: number}
