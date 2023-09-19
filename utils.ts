import {youtube_v3} from '@googleapis/youtube'
import {exec} from 'child_process'
import fs from 'node:fs'
import type {PageData} from './youtubeApiCalls'

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

type GetUnavailableVideoPlaylistItemIdsInput = Pick<
  PageData,
  'playlistResponse' | 'videosResponse'
>

export function getUnavailableVideoPlaylistItemIds({
  playlistResponse,
  videosResponse,
}: GetUnavailableVideoPlaylistItemIdsInput): string[] {
  const playlistItems = playlistResponse.data.items ?? []
  const videoItems = videosResponse.data.items ?? []
  const videoIdSet = new Set(videoItems.map(({id}) => id))
  const missingPlaylistVideos = playlistItems.filter(
    ({contentDetails}) => !videoIdSet.has(contentDetails?.videoId)
  )

  return missingPlaylistVideos.reduce((acc: string[], {id}) => {
    if (id) acc.push(id)
    return acc
  }, [])
}

export type Video = {
  id: string
  title: string
  channel: string
  dateAddedToPlaylist: string
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
export function getVideoMetadata(allPages: PageData[]): Video[] {
  return allPages
    .reduce((acc: Video[], {videosResponse}) => {
      videosResponse.data.items?.forEach(item => {
        const {id} = item
        const {
          channelTitle: channel,
          title,
          publishedAt: dateAddedToPlaylist,
        } = item.snippet ?? {}
        const url = `https://www.youtube.com/watch?v=${id}`
        const lengthInSeconds = parseISO8601Duration(
          item.contentDetails?.duration
        )

        if (
          !id ||
          !title ||
          !channel ||
          !dateAddedToPlaylist ||
          lengthInSeconds === null
        ) {
          throw new Error('Property missing from video')
        }

        acc.push({
          id,
          title,
          channel,
          dateAddedToPlaylist,
          url,
          lengthInSeconds,
        })
      })

      return acc
    }, [])
    .sort((a, b) => {
      if (a.dateAddedToPlaylist < b.dateAddedToPlaylist) return 1
      if (a.dateAddedToPlaylist > b.dateAddedToPlaylist) return -1
      return 0
    })
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

/**
 * Download a YouTube video as an mp3 file using the `yt-dlp` command line
 * package. You can conveniently install it with `brew install yt-dlp`.
 */
function downloadVideo(videoUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    /**
     * https://github.com/yt-dlp/yt-dlp#output-template
     * This is Python syntax and the trailing 's' after the parenthesis
     * indicates the preceding value is a string.
     *
     * https://www.perplexity.ai/search/fb927e12-6b12-4fac-b33d-363c760661ca?s=u
     * Prefer `title` over `fulltitle`
     */
    const template = `-o './data/audio/%(title)s [%(id)s].%(ext)s'`

    // https://github.com/yt-dlp/yt-dlp
    const command = `yt-dlp ${template} --extract-audio --audio-format mp3 --audio-quality 0 -- ${videoUrl}`
    exec(command, error => (error ? reject(error) : resolve()))
  })
}

/**
 * Download all YouTube videos as mp3 files using the `yt-dlp` command line
 * package.
 */
export async function downloadAllVideos({
  videos,
  existingIds,
  maxLengthInSeconds,
}: {
  videos: Video[]
  existingIds: Set<string>
  maxLengthInSeconds: number
}) {
  // Avoid fetching and creating audio we already have.
  const videosToProcess = videos.filter(({id, lengthInSeconds}) => {
    return !existingIds.has(id) && lengthInSeconds <= maxLengthInSeconds
  })
  const totalVideoCount = videosToProcess.length

  if (!totalVideoCount) {
    console.log('😎 All videos already accounted for')
    return
  }

  const promiseFxns = videosToProcess.map(({title, url}, i) => {
    const counter = `(${i + 1} of ${totalVideoCount})`

    return () => {
      console.log(`${counter} Downloading ${title}...`)

      return downloadVideo(url)
        .then(() => {
          console.log(`${counter} ✅ Success!`)
        })
        .catch(() => {
          console.log(`${counter} ❌ Failed to download`)
        })
    }
  })

  return promiseFxns.reduce((acc, fxn) => {
    return acc.then(fxn)
  }, Promise.resolve())
}

/**
 * Reads the './data/audio' folder, iterates through all the files, and pulls
 * out the YouTube id from each file. Returns a set of the ids.
 *
 * File format is: `<title> [<id>].mp3`
 */
export function getExistingAudioIds(): Set<string> {
  const existingFileNames = fs.readdirSync('./data/audio')

  return existingFileNames.reduce((acc, fileName) => {
    if (!fileName.endsWith('.mp3')) return acc

    // 'Video Title [123].mp3' => '123
    const id = fileName.split(' ').pop()?.split('.')[0].slice(1, -1)
    if (id) acc.add(id)

    return acc
  }, new Set<string>())
}
