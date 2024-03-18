# Download YouTube Playlist

Download all videos from a YouTube playlist. You can optionally download the audio and thumbnail images as well.

## Prerequisites

You'll need a few things to use this project:

- This project uses [Bun](https://bun.sh/)! Get that installed or feel free to edit the source code to use Node instead (it'll only be a few adjustments).
- You'll need a [YouTube Data API](https://developers.google.com/youtube/v3) key. Set that to the `API_KEY` env variable.
- The [yt-dlp](https://github.com/yt-dlp/yt-dlp) command line tool needs to be present on your system. You can easily install it with a tool like [Brew](https://formulae.brew.sh/formula/yt-dlp).

## Usage

The type signature looks like this:

```typescript
downloadYoutubePlaylist({
  // YouTube playlist id.
  playlistId: string

  // YouTube API key.
  apiKey: string

  // Full path to the directory you want to save your data.
  directory: string

  /**
   * 'audio' - will only save videos as mp3 files and include json metadata
   * 'video' - will only save videos as mp4 files and incluide json metadata
   * 'both' - will save videos as mp3 and mp4 files and include json metadata
   * 'none' - will only save json metadata
   */
  downloadType: DownloadType

  /**
   * Optional - default value `false`
   *
   * Boolean indicating if the full playlist data get's fetched or not.
   *
   * `true`  - download all items in the playlist
   * `false` - download only the 50 most recent items in the playlist
   */
  includeFullData?: boolean

  /**
   * Optional - default value `Infinity`
   *
   * The maximum duration a playlist item can be to be downloaded.
   */
  maxDurationSeconds?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating whether to download the video thumbnails as jpg files.
   */
  downloadThumbnails?: boolean

  /**
   * Optiona - default value `false`
   *
   * Boolean indicated whether to save the response data directly from the
   * YouTube API. This can be helpful for debugging. If set to `true`, two files
   * will be saved:
   *
   * - youtubePlaylistResponses.json
   * - youtubeVideoResponses.json
   */
  saveRawResponses?: boolean
}): Promise<{
  failures: {
    url: string // The url of failed resource.
    title: string // The video title.
    error: unknown

    /**
     * 'video' - the attempted download was a YouTube video.
     * 'thumbnail' - the attempted download was a thumbnail image.
     * 'ffmpeg' - ffmpeg failed to convert the downloaded video into an mp3 file.
     */
    type: 'video' | 'thumbnail' | 'ffmpeg'
  }[]
  failureCount: number
  date: string // new Date().toLocaleDateString()
  dateNum: number // Date.now()
  totalVideosDownloaded: number
  totalThumbnailsDownloaded: number
}>
```

## Folder Structure

Downloads will be organized into the following folder structure:

```
data
  /<playlist name>
    /video
      <title> [<video id>].mp4
      ...
    /audio
      <title> [<video id>].mp3
      ...
    /thumbnails
      <video id>.jpg
      ...
    metadata.json
    youtubePlaylistResponses.json (only if `saveRawResponses` is true)
    youtubeVideoResponses.json (only if `saveRawResponses` is true)
```

<table>
  <tr>
    <td><code>/video</code></td>
    <td>This folder will contain all the mp4 video files</td>
  </tr>
  <tr>
    <td><code>/audio</code></td>
    <td>This folder will contain all the mp3 audio files</td>
  </tr>
  <tr>
    <td><code>/thumbnails</code></td>
    <td>This folder will contain all the jpg thumbnail files</td>
  </tr>
  <tr>
    <td><code>metadata.json</code></td>
    <td>This file will contain an array of metadata on each video. See shape below</td>
  </tr>
  <tr>
    <td><code>youtubePlaylistResponses.json</code></td>
    <td>This file will contain an array of raw responses from YouTube's <a href="https://developers.google.com/youtube/v3/docs/playlistItems/list">PlaylistItems: list</a> api.</td>
  </tr>
  <tr>
    <td><code>youtubeVideoResponses.json</code></td>
    <td>This file will contain an array of raw responses from YouTube's <a href="https://developers.google.com/youtube/v3/docs/videos/list">Videos: list</a> api.</td>
  </tr>
</table>

## Metadata Shape

Each video will have metadata stored in the `metadata.json` with the following shape:

```typescript
{
  id: string
  title: string
  channelId: string
  channelName: string
  dateAddedToPlaylist: string
  durationInSeconds: number | null
  url: string
  thumbnaillUrl: string
  dateCreated: string

  /**
   * This value will be changed to `true` when future API calls are made and the
   * video is found to be unavailable. This will allow us to retain previously
   * fetch metadata.
   */
  isUnavailable?: boolean
}
```
