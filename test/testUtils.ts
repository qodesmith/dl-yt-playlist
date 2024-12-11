import type {youtube_v3} from '@googleapis/youtube'
import type {GaxiosResponse} from 'googleapis-common'

import path from 'node:path'

import {chunkArray} from '@qodestack/utils'
import {mock} from 'bun:test'

type PlaylistResponse =
  GaxiosResponse<youtube_v3.Schema$PlaylistItemListResponse>['data']
type PlaylistResponseVideo = NonNullable<PlaylistResponse['items']>[number]

type MockOptions = {
  deletedIds?: string[]
  privateIds?: string[]
}

export async function genMockYoutubeResponses({
  deletedIds,
  privateIds,
}: MockOptions = {}) {
  /**
   * `downloadYouTubePlaylist` makes multiple calls to these endpoints to
   * retrieve the full data. Each response is different, so these `count`
   * variables help us determine which response to return.
   */
  let playlistItemCallsCount = 0
  let videoCallsCount = 0

  const playlistJsonPath = path.resolve(
    import.meta.dirname,
    './youtubePlaylistResponses.json'
  )
  const playlistResponses: PlaylistResponse[] = await Bun.file(
    playlistJsonPath
  ).json()

  // Update deleted or private video titles to how the API would return them.
  playlistResponses.forEach(response => {
    response.items?.forEach(item => {
      if (item.snippet) {
        if (deletedIds?.includes(item.snippet?.resourceId?.videoId ?? '')) {
          item.snippet.title = 'Deleted video'
        }

        if (privateIds?.includes(item.snippet?.resourceId?.videoId ?? '')) {
          item.snippet.title = 'Private video'
        }
      }
    })
  })

  mock.module('@googleapis/youtube', () => {
    return {
      default: {
        youtube: () => {
          return {
            playlistItems: {
              list: () => {
                /**
                 * The `@googleapis/youtube` package wraps the responses with
                 * extra metadata, such as the `data` property.
                 */
                return {data: playlistResponses[playlistItemCallsCount++]}
              },
            },
            videos: {
              list: () => {
                const allVideoItems = playlistResponses.reduce<
                  PlaylistResponseVideo[]
                >((acc, response) => {
                  response.items?.forEach(item => {
                    const title = item.snippet?.title

                    if (
                      title !== 'Deleted video' &&
                      title !== 'Private video'
                    ) {
                      acc.push(item)
                    }
                  })

                  return acc
                }, [])
                const items = chunkArray(allVideoItems, 3)[videoCallsCount++]

                if (!items) {
                  throw new Error(
                    `No videos found at index ${videoCallsCount}. ${allVideoItems.length} total videos.`
                  )
                }

                return {
                  data: {
                    kind: 'youtube#videoListResponse',
                    etag: 'S2TrjnZmeUReqwuo_MdbqHoLDZw',
                    items,
                    pageInfo: {
                      totalResults: items.length,
                      resultsPerPage: items.length,
                    },
                  },
                }
              },
            },
          }
        },
      },
    }
  })
}
