import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponseWithHTTP2} from 'googleapis-common'
import type {Failure} from './types'

import {execSync} from 'node:child_process'
import fs from 'node:fs'

import {errorToObject, pluralize, sanitizeDecimal} from '@qodestack/utils'

export const MAX_YOUTUBE_RESULTS = 50

/**
 * Uses the YouTube
 * [PlaylistItems API](https://developers.google.com/youtube/v3/docs/playlistItems)
 * to fetch metadata on videos.
 *
 * This function intentionally doesn't massage the API responses and leaves that
 * responsibility up to consumers for cleaner, more predictable code.
 */
export async function genPlaylistItems({
  yt,
  playlistId,
  youTubeFetchCount,
  totalItemsToFetch,
}: {
  /** The YouTube API class used to make the fetch calls. */
  yt: youtube_v3.Youtube

  /** Playlist id. */
  playlistId: string

  /** A counter to track how many fetch calls are made. */
  youTubeFetchCount: {count: number}

  /** Maximum number of videos to fetch from the API. */
  totalItemsToFetch: number
}): Promise<
  GaxiosResponseWithHTTP2<youtube_v3.Schema$PlaylistItemListResponse>[]
> {
  return _genPlaylistItems({
    yt,
    playlistId,
    youTubeFetchCount,
    totalItemsToFetch,

    /**
     * These values are meant to kick off the process. They will be updated in
     * recursive calls.
     */
    itemsFetchedCount: 0,
    pageToken: undefined,
    responses: [],
  })
}

/**
 * Internal counterpart to `genPlaylistItems`. This function calls itself
 * recursively.
 */
async function _genPlaylistItems({
  yt,
  playlistId,
  youTubeFetchCount,
  totalItemsToFetch,
  itemsFetchedCount,
  pageToken,
  responses,
}: {
  /** The YouTube API class used to make the fetch calls. */
  yt: youtube_v3.Youtube

  /** Playlist id. */
  playlistId: string

  /** A counter to track how many fetch calls are made. */
  youTubeFetchCount: {count: number}

  /** Maximum number of videos to fetch from the API. */
  totalItemsToFetch: number

  /**
   * Each response from the API will have a list of items. These are the
   * individual video metadata objects. We specifiy how many of these we want
   * via `totalItemsToFetch`. This number represents how many have been fetched
   * so far.
   */
  itemsFetchedCount: number

  /**
   * A value returned by the API indicating there are more results to be
   * fetched.
   */
  pageToken: string | undefined

  /**
   * Will be provided in resursive calls. An array retaining all API responses.
   */
  responses: Awaited<
    GaxiosResponseWithHTTP2<youtube_v3.Schema$PlaylistItemListResponse>
  >[]
}): Promise<
  GaxiosResponseWithHTTP2<youtube_v3.Schema$PlaylistItemListResponse>[]
> {
  const itemsLeftToFetch = totalItemsToFetch - itemsFetchedCount
  const maxResults =
    itemsLeftToFetch > 0 && itemsLeftToFetch <= MAX_YOUTUBE_RESULTS
      ? itemsLeftToFetch
      : MAX_YOUTUBE_RESULTS

  const response = await yt.playlistItems.list({
    playlistId,
    part: ['contentDetails', 'snippet'],
    maxResults,
    pageToken,
  })

  youTubeFetchCount.count++

  const {nextPageToken, items} = response.data
  const updatededResponses = responses.concat(response)
  const newItemsFetchedCount = itemsFetchedCount + (items?.length ?? 0)
  const shouldContinueFetching = totalItemsToFetch - newItemsFetchedCount > 0

  if (nextPageToken && shouldContinueFetching) {
    return _genPlaylistItems({
      yt,
      playlistId,
      youTubeFetchCount,
      totalItemsToFetch,
      itemsFetchedCount: newItemsFetchedCount,
      pageToken: nextPageToken,
      responses: updatededResponses,
    })
  }

  return updatededResponses
}

/**
 * Thumbnails have a number of potential urls in varying quality. The `urls`
 * value comes in sorted from highest quality to lowest. This function will
 * attempt to download the thumbnail, starting from the first url. If the
 * download fails, a `Failure` is thrown.
 */
export async function downloadThumbnailFile({
  urls,
  id,
  thumbnailDirectory,
}: {
  urls: string[]
  id: string
  thumbnailDirectory: string
}): Promise<undefined> {
  return _downloadThumbnailFile({urls, id, thumbnailDirectory, index: 0})
}

/**
 * Internal counterpart to `downloadThumbnailFile`. This function calls itself
 * recursively.
 */
async function _downloadThumbnailFile({
  urls,
  id,
  thumbnailDirectory,
  index,
  redirectedUrl,
}: {
  urls: string[]
  id: string
  thumbnailDirectory: string
  index: number
  redirectedUrl?: string
}): Promise<undefined> {
  if (index >= urls.length) {
    const failure: Failure = {
      type: 'thumbnailUrlNotAvailable',
      urls,
      videoId: id,
      date: Date.now(),
    }

    throw failure
  }

  // We know we have a string based on the check above.
  const url = redirectedUrl ?? urls[index] ?? ''

  return fetch(url, {
    method: 'GET',
    headers: {'Content-Type': 'image/jpg'},
    redirect: 'follow',
  }).then(async res => {
    // 400s - try with the next url in the list.
    if (res.status >= 400 && res.status <= 499) {
      return _downloadThumbnailFile({
        urls,
        id,
        thumbnailDirectory,
        index: index + 1,
      })
    }

    // 300s - retry with the redirected url.
    if (res.status >= 300 && res.status <= 399) {
      return _downloadThumbnailFile({
        urls,
        id,
        thumbnailDirectory,
        index,
        redirectedUrl: res.url,
      })
    }

    if (!res.ok) {
      const failure: Failure = {
        type: 'thumbnailDownload',
        url,
        status: res.status,
        statusText: res.statusText,
        date: Date.now(),
      }

      throw failure
    }

    try {
      await Bun.write(`${thumbnailDirectory}/${id}.jpg`, res)
    } catch (error) {
      const failure: Failure = {
        type: 'Bun.write',
        file: `${thumbnailDirectory}/${id}.jpg`,
        error: errorToObject(error),
        date: Date.now(),
      }

      throw failure
    }
  })
}

export function getLufsForFile(filePath: string): number | {error: string} {
  try {
    const command = `ffmpeg -i ${filePath} -filter_complex ebur128 -f null - 2>&1 | grep -E 'I:.+ LUFS$' | tail -1`
    const result = execSync(command)
    const resArray = result.toString().trim().split(' ') // ["I:", "", "", "", "", "", "", "", "", "-12.8", "LUFS"]
    const lastItem = resArray.at(-1)
    const isError = !lastItem || lastItem.toLowerCase() !== 'lufs'

    if (isError) return {error: 'Unable to parse LUFS from ffmpeg command'}

    const valueItem = resArray.at(-2)
    const num = Number(valueItem)

    return Number.isNaN(num) ? {error: `Unexpected \`NaN\`: ${valueItem}`} : num
  } catch (e) {
    return {error: (e as Error).message}
  }
}

/**
 * This function tries to create a directory. If it already exists, an error
 * will be thrown. This function prevents that error from being thrown.
 */
export function mkdirSafe(dir: string) {
  try {
    fs.mkdirSync(dir)
  } catch {
    // Noop
  }
}

export function parseISO8601DurationToSeconds(durationString: string) {
  const regex =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/

  const matches = durationString.match(regex) ?? []
  const years = matches[1] ? parseInt(matches[1], 10) : 0
  const months = matches[2] ? parseInt(matches[2], 10) : 0
  const weeks = matches[3] ? parseInt(matches[3], 10) : 0
  const days = matches[4] ? parseInt(matches[4], 10) : 0
  const hours = matches[5] ? parseInt(matches[5], 10) : 0
  const minutes = matches[6] ? parseInt(matches[6], 10) : 0
  const seconds = matches[7] ? parseFloat(matches[7]) : 0
  const totalSeconds =
    years * 31_536_000 +
    months * 2_592_000 +
    weeks * 604_800 +
    days * 86_400 +
    hours * 3600 +
    minutes * 60 +
    seconds

  return totalSeconds
}

/**
 * Converts a number of milliseconds into a plain-english string, such as
 * "4 minutes 32 seconds"
 */
export function sanitizeTime(ms: number): string {
  const totalSeconds = ms / 1000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = sanitizeDecimal(totalSeconds % 60)
  const secondsFinalValue = pluralize(seconds, 'second')

  return minutes
    ? `${pluralize(minutes, 'minute')} ${secondsFinalValue}`
    : secondsFinalValue
}
