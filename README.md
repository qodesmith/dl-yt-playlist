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
  /** YouTube playlist id. */
  playlistId: string

  /**
   * YouTube API key. This will be used to fetch all metadata for videos in the
   * playlist.
   */
  youTubeApiKey: string

  /**
   * The absolute path to where the data should be stored. Sub-folders will be
   * created as needed. The folder structure will be:
   *
   * - `<directory>/metadata.json` - an array of objects (`Video[]`)
   * - `<directory>/audio` - contains the audio files
   * - `<directory>/video` - contains the video files
   * - `<directory>/thumbnails` - contains the jpg thumbnail files
   */
  directory: string

  /**
   * `'none'`  - No files will be downloaded, including thumbnails. Only the
   *             `metadata.json` file will be written.
   *
   * `'audio'` - Download only audio files as determined by the `audioFormat`
   *             option. Defaults to `'mp3'`.
   *
   * `'video'` - Download only video files as determined by the `videoFormat`
   *             option. Defaults to `'mp4'`
   *
   * `'both'`  - Download audio and video files as determined by their
   *             corresponding format options.
   */
  downloadType: DownloadType

  /**
   * Optional - default value `'mp3'`
   *
   * A valid ffmpeg audio [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  audioFormat?: string

  /**
   * Optional - default value `'mp4'`
   *
   * A valid ffmpeg video [format](https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#format-selection) string.
   */
  videoFormat?: string

  /**
   * Optional - default value `false`
   *
   * A boolean indicating wether to download a `.jpg` thumbnail for each video.
   * The highest resolution available will be downloaded. Only thumbnails for
   * new videos will be downloaded.
   */
  downloadThumbnails?: boolean

  /**
   * Optional - default value `Infinity`
   *
   * The maximum duration in seconds a playlist item can be to be downloaded.
   */
  maxDurationSeconds?: number

  /**
   * Optional - default value `undefined`
   *
   * A _positive_ number (max of 50) indicating how many items in the playlist
   * to retrieve, starting with the most recent. Negative and invalid numbers
   * will be ignored. All items will be retrieved if no value is provided.
   *
   * I.e. `mostRecentItemsCount: 20` will only retrieve data for the most recent
   * 20 videos in the playlist. This option is useful when running in a cron job
   * to avoid fetching and parsing the entire list when you may already have a
   * substantial portion processed and downloaded already.
   */
  mostRecentItemsCount?: number

  /**
   * Optional - default value `false`
   *
   * Boolean indicating wether to silence all internal console.log's.
   */
  silent?: boolean

  /**
   * Optional - deafaults to the system time zone.
   *
   * String indicating what timezone to use for the logger.
   */
  timeZone?: string

  /**
   * Options - default value `4`
   *
   * The number of concurrent fetch calls made to the YouTube
   * [VideosList API](https://developers.google.com/youtube/v3/docs/videos/list).
   */
  maxConcurrentFetchCalls?: number

  /**
   * Options - default value `10`
   *
   * The number of concurrent downloads to process. We use
   * [Bun's shell](https://bun.sh/docs/runtime/shell) to asychronously execute
   * the [yt-dlp](https://github.com/yt-dlp/yt-dlp) command.
   */
  maxConcurrentYtdlpCalls?: number

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
}): Promise<FailuresObj>
```

## Folder Structure

Downloads will be organized into the following folder structure:

```
directory-you-provided
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
    <td>This folder will contain all the video files (file extension is dependent upon `audioFormat` option).</td>
  </tr>
  <tr>
    <td><code>/audio</code></td>
    <td>This folder will contain all the audio files (file extension is dependent upon `videoFormat` option).</td>
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

Each video will have metadata stored in the `metadata.json` file with the following shape:

```typescript
{
  id: string
  title: string
  description: string
  channelId: string
  channelName: string
  dateCreated: string
  dateAddedToPlaylist: string
  thumbnailUrl: string | null
  durationInSeconds: number
  url: string
  channelUrl: string | null
  audioFileExtension: string | null
  videoFileExtension: string | null

  /**
   * This value will be changed to `true` when future API calls are made and the
   * video is found to be unavailable. This will allow us to retain previously
   * fetch metadata.
   */
  isUnavailable: boolean
}
```
