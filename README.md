# Download YouTube Playlist

Download all YouTube videos (or audio only) from every video in a playlist!

## Prerequisites

You'll need a few things to use this project:

- This project uses [Bun](https://bun.sh/)! Get that installed or feel free to edit the source code to use Node instead (it'll only be a few adjustments).
- You'll need a [YouTube Data API](https://developers.google.com/youtube/v3) key. Set that to the `API_KEY` env variable.
- The [yt-dlp](https://github.com/yt-dlp/yt-dlp) command line tool needs to be present on your system. You can easily install it with a tool like [Brew](https://formulae.brew.sh/formula/yt-dlp).

## Usage

Say you have this code in a file named `download.ts`:

```typescript
import dl from 'dl-yt-playlist'

const {playlistId, apiKey} = process.env

dl({
  // Required:
  playlistId: string, // The YouTube playlist id
  apiKey: string, // Your YouTube Data api key

  // Optional:
  audioOnly: boolean, // `true` for audio MP3, `false` for video MP4
  getFullData: boolean, // `false` will only get the 1st 50 videos
  maxLengthInSeconds: number, // Videos longer than this will be skipped
})
```

Now you can use [Bun](https://bun.sh/) to run the file:

```bash
bun run download.ts
```

## Folder Structure

Downloads will be organized into the following folder structure:

```
data
  /<playlist name>
    /video
    /audio
    responses.json
    videoMetadata.json
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
    <td><code>responses.json</code></td>
    <td>This file will contain <em>all</em> the responses from the YouTube api. This is useful for understanding the shape of the data.</td>
  </tr>
  <tr>
    <td><code>videoMetadata.json</code></td>
    <td>This file will contain an array metadata on each video. See shape below</td>
  </tr>
</table>

## Video Metadata Shape

Each video will have metadata stored in the `videoMetadata.json` with the following shape:

```typescript
{
  id: string
  title: string
  channel: string
  dateAddedToPlaylist: string
  url: string
  lengthInSeconds: number
}
```
