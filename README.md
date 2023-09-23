# Download YouTube Playlist

Download all YouTube videos (or audio only) from every video in a playlist!

## Prerequisites

You'll need a few things to use this project:

- This project uses [Bun](https://bun.sh/)! Get that installed or feel free to edit the source code to use Node instead (it'll only be a few adjustments).
- You'll need a [YouTube Data API](https://developers.google.com/youtube/v3) key. Set that to the `API_KEY` env variable.
- The [yt-dlp](https://github.com/yt-dlp/yt-dlp) command line tool needs to be present on your system. You can easily install it with a tool like [Brew](https://formulae.brew.sh/formula/yt-dlp).

## Usage

Download all videos:

```
bun start
```

Download all videos as MP3 files:

```
bun audio
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

## TODOs

[ ] Implement "initialDownload" which conditionally downloads all YT metadata otherwise only makes a single call for the 1st 50 entries
