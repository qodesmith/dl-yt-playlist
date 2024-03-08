import fs from 'node:fs'
import {squareBracketIdRegex} from './utils'
import {PageData} from './youtubeApiCalls'

type GetDeactivatedVideosInput = {
  directory: string
  playlistName: string
}

type DeactivatedVideo = {
  name: string
  id: string | undefined
}

/**
 * These are videos that have been download but are no longer available.
 * Videos may have been deleted or turned private.
 */
export function getDeactivatedVideos({
  directory,
  playlistName,
}: GetDeactivatedVideosInput): DeactivatedVideo[] {
  const playlistDir = `${directory}/${playlistName}`
  const ytResponses: PageData[] = JSON.parse(
    fs.readFileSync(`${playlistDir}/responses.json`, {encoding: 'utf8'})
  )
  const unavailableVideoIdsSet = new Set(
    ytResponses.flatMap(ytResponse => ytResponse.unavailableItemIds)
  )

  return ['audio', 'video'].reduce<DeactivatedVideo[]>((acc, folder) => {
    const dir = `${playlistDir}/${folder}`

    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(fileName => {
        if (fileName.endsWith('.mp3') || fileName.endsWith('.mp4')) {
          // 'Video Title [123-_abc123].mp3' => '123-_abc123'
          const id = fileName.match(squareBracketIdRegex)?.[1]

          if (id && unavailableVideoIdsSet.has(id)) {
            acc.push({name: fileName, id})
          }
        }
      })
    }

    return acc
  }, [])
}
