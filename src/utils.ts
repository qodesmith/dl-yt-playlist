import {execSync} from 'node:child_process'
import fs from 'node:fs'

import {errorToObject, pluralize, sanitizeDecimal} from '@qodestack/utils'

import {Failure} from './types'

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
  const url = redirectedUrl ?? urls[index]!

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

    return isNaN(num) ? {error: `Unexpected \`NaN\`: ${valueItem}`} : num
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
