import type {BaseIssue} from 'valibot'

import {$} from 'bun'
import fs from 'node:fs'

import {safeParse} from 'valibot'

import {YtDlpJsonSchema} from './schemas'
import {getLufsForFile} from './utils'

export type SingleVideo = {
  id: string
  title: string
  description: string
  channelId: string
  channelName: string
  duration: number
  url: string
  channelUrl: string
  videoFileExtension: string
  lufs: number | null
}

export type SingleVideoFailure =
  | {
      type: 'bunShell'
      exitCode: number
      stderr: string
    }
  | {
      type: 'schemaParse'
      issues: BaseIssue<unknown>[]
    }
  | {
      type: 'lufs'
      errorMessage: string
    }

export type DownloadYouTubeVideoInput = {
  videoId: string
  directory: string
}

export type DownloadYouTubeVideoOutput = {
  video: SingleVideo | null
  failures: SingleVideoFailure[]
}

export async function downloadYouTubeVideo({
  videoId,
  directory,
}: DownloadYouTubeVideoInput): Promise<DownloadYouTubeVideoOutput> {
  const ytDlpPath = Bun.which('yt-dlp')

  if (!ytDlpPath) {
    throw new Error('Missing `yt-dlp`')
  }

  if (!fs.existsSync(directory)) {
    throw new Error(`Directory doesn't exist - ${directory}`)
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`
  const template = `${directory}/%(id)s.%(ext)s`
  const failures: SingleVideoFailure[] = []
  const video: SingleVideo | null =
    await $`yt-dlp -o "${template}" -J --no-simulate ${url}`
      .nothrow()
      .quiet()
      .then(({exitCode, stdout, stderr}) => {
        if (exitCode !== 0) {
          failures.push({
            type: 'bunShell',
            exitCode,
            stderr: stderr.toString(),
          })
        }

        const parsedResults = safeParse(
          YtDlpJsonSchema,
          JSON.parse(stdout.toString())
        )

        if (!parsedResults.success) {
          failures.push({
            type: 'schemaParse',
            issues: parsedResults.issues,
          })

          return null
        }

        const {output} = parsedResults
        const lufs = getLufsForFile(`${directory}/${videoId}.${output.ext}`)
        const lufsIsNum = typeof lufs === 'number'

        if (!lufsIsNum) {
          failures.push({
            type: 'lufs',
            errorMessage: lufs.error,
          })
        }

        const singleVideo: SingleVideo = {
          id: videoId,
          title: output.title,
          description: output.description,
          channelId: output.channel_id,
          channelName: output.channel,
          duration: output.duration,
          url,
          channelUrl: output.channel_url,
          videoFileExtension: output.ext,
          lufs: lufsIsNum ? lufs : null,
        }

        return singleVideo
      })

  return {video, failures}
}
