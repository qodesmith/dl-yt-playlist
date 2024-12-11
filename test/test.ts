import fs from 'node:fs'
import path from 'node:path'

import {test, describe, beforeEach, expect, afterEach, mock} from 'bun:test'
import dotenv from 'dotenv'

import {genMockYoutubeResponses} from './testUtils'
import {downloadYouTubePlaylist} from '../src/main'
import {DownloadYouTubePlaylistInput} from '../src/types'

const envDir = path.resolve(import.meta.dirname, '../.env')
const mediaDir = path.resolve(import.meta.dirname, './media')

dotenv.config({path: envDir})

const {PLAYLIST_ID, API_KEY} = process.env

if (!PLAYLIST_ID || !API_KEY) {
  throw new Error('Missing env variables')
}

const baseOptions: Pick<
  DownloadYouTubePlaylistInput,
  'playlistId' | 'youTubeApiKey' | 'silent'
> = {playlistId: PLAYLIST_ID, youTubeApiKey: API_KEY, silent: true}

describe('downloadYoutubePlaylist', () => {
  beforeEach(async () => {
    // Previous test runs may have failed, leaving this dir. Remove it.
    fs.rmSync(mediaDir, {recursive: true, force: true})

    // Ensure the base media directory exists for each test.
    fs.mkdirSync(mediaDir)

    await genMockYoutubeResponses()
  })

  afterEach(() => {
    fs.rmSync(mediaDir, {recursive: true, force: true})
    mock.restore()
  })

  test('download single audio file', async () => {
    const data: {videoId?: string} = {}
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'audio',
      getIdsForDownload: ids => {
        data.videoId = ids[0]!
        return ids.slice(0, 1) // Only 1 id.
      },
      directory: mediaDir,
      audioFormat: 'mp3',
      downloadThumbnails: false,
    })

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeFalse()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeFalse()

    const contents = fs.readdirSync(`${mediaDir}/audio`, {withFileTypes: true})

    // One file should have been downloaded.
    expect(contents).toBeArrayOfSize(1)
    expect(contents[0]?.name).toBe(`${data.videoId}.mp3`)

    // Assert relevant results data.
    expect(results.videoListResponses).toBeArrayOfSize(1)
    expect(results.videosDownloaded).toBeArrayOfSize(1)
    expect(results.videosDownloaded[0]!.id).toBe(data.videoId!)
    expect(results.downloadCount).toEqual({audio: 1, video: 0, thumbnail: 0})
    expect(results.youTubeFetchCount).toBe(4)
  })

  test('download multiple audio files', async () => {
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'audio',
      getIdsForDownload: ids => {
        return ids.slice(0, 2)
      },
      directory: mediaDir,
      audioFormat: 'mp3',
      downloadThumbnails: false,
    })

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeFalse()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeFalse()

    const contents = fs.readdirSync(`${mediaDir}/audio`, {withFileTypes: true})

    expect(contents).toBeArrayOfSize(2)
    expect(contents.every(({name}) => name.endsWith('.mp3'))).toBeTrue()

    // Assert relevant results data.
    expect(results.videosDownloaded).toBeArrayOfSize(2)
    expect(results.downloadCount).toEqual({audio: 2, video: 0, thumbnail: 0})
  })

  test('download single video file', async () => {
    const videoId = 'fs3uFABbcvQ'
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'video',
      getIdsForDownload: ids => {
        return ids.filter(id => id === videoId)
      },
      directory: mediaDir,
      videoFormat: 'mp4',
      downloadThumbnails: false,
    })

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeFalse()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeFalse()

    const contents = fs.readdirSync(`${mediaDir}/video`, {withFileTypes: true})

    // One file should have been downloaded.
    expect(contents).toBeArrayOfSize(1)
    expect(contents[0]?.name).toBe(`${videoId}.mp4`)

    // Assert relevant results data.
    expect(results.videoListResponses).toBeArrayOfSize(1)
    expect(results.videosDownloaded).toBeArrayOfSize(1)
    expect(results.videosDownloaded[0]!.id).toBe(videoId)
    expect(results.downloadCount).toEqual({audio: 0, video: 1, thumbnail: 0})
    expect(results.youTubeFetchCount).toBe(4)
  })

  test('download multiple video files', async () => {
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'video',
      getIdsForDownload: ids => {
        return ids.slice(0, 2)
      },
      directory: mediaDir,
      videoFormat: 'mp4',
      downloadThumbnails: false,
    })

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeFalse()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeFalse()

    const contents = fs.readdirSync(`${mediaDir}/video`, {withFileTypes: true})

    expect(contents).toBeArrayOfSize(2)
    expect(contents.every(({name}) => name.endsWith('.mp4'))).toBeTrue()

    // Assert relevant results data.
    expect(results.videosDownloaded).toBeArrayOfSize(2)
    expect(results.downloadCount).toEqual({audio: 0, video: 2, thumbnail: 0})
  })

  test('download both with thumbnails', async () => {
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'both',
      getIdsForDownload: ids => {
        return ids.slice(0, 2)
      },
      directory: mediaDir,
      audioFormat: 'mp3',
      videoFormat: 'mp4',
      downloadThumbnails: true,
    })

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeTrue()

    const audioDir = fs.readdirSync(`${mediaDir}/audio`, {withFileTypes: true})
    const videoDir = fs.readdirSync(`${mediaDir}/video`, {withFileTypes: true})
    const thumbDir = fs.readdirSync(`${mediaDir}/thumbnails`, {
      withFileTypes: true,
    })

    expect(audioDir).toBeArrayOfSize(2)
    expect(videoDir).toBeArrayOfSize(2)
    expect(thumbDir).toBeArrayOfSize(2)

    expect(audioDir.every(({name}) => name.endsWith('.mp3')))
    expect(videoDir.every(({name}) => name.endsWith('.mp4')))
    expect(thumbDir.every(({name}) => name.endsWith('.jpg')))

    expect(results.downloadCount).toEqual({audio: 2, video: 2, thumbnail: 2})
    expect(results.videosDownloaded).toBeArrayOfSize(2)
  })

  test('download none', async () => {
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'none',
    })

    expect(fs.readdirSync(mediaDir)).toBeArrayOfSize(0)
    expect(results.downloadCount).toEqual({audio: 0, video: 0, thumbnail: 0})
    expect(results.videosDownloaded).toBeArrayOfSize(0)
  })

  test('yt-dlp and ffmpeg check', async () => {
    const originalBunWhich = Bun.which
    Bun.which = () => null

    const shouldThrow = async () => {
      return downloadYouTubePlaylist({...baseOptions, downloadType: 'none'})
    }

    expect(shouldThrow).toThrow('Missing `yt-dlp` or `ffmpeg`')

    Bun.which = originalBunWhich
  })

  test('correct return type', async () => {
    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'none',
    })

    // expect(results.playlistItemListResponses).toBeArray()
    expect(results.videoListResponses).toBeArray()
    expect(results.videosDownloaded).toBeArray()
    expect(results.unavailableVideos).toBeArray()
    expect(results.failures).toBeArray()
    expect(results.downloadCount).toEqual({audio: 0, video: 0, thumbnail: 0})
    expect(results.youTubeFetchCount).toBeNumber()

    const resultsKeys = Object.keys(results)

    expect(resultsKeys).toBeArrayOfSize(7)
    expect(resultsKeys).toContainAllValues([
      'playlistItemListResponses',
      'videoListResponses',
      'videosDownloaded',
      'unavailableVideos',
      'failures',
      'downloadCount',
      'youTubeFetchCount',
    ])
  })

  test.only('unavailable video (title is "Private video" or "Deleted video")', async () => {
    await genMockYoutubeResponses({
      deletedIds: ['JKEJBeoEGfk', 'SL22bO3Luw8', 'y6ZeWhBtKVk', 'H4mCs2Mg-dc'],
      privateIds: ['gIdp_KplH50', 'Fp6CnOG2VS0'],
    })

    const results = await downloadYouTubePlaylist({
      ...baseOptions,
      downloadType: 'both',
      getIdsForDownload: ids => ids,
      directory: mediaDir,
      audioFormat: 'mp3',
      videoFormat: 'mp4',
      downloadThumbnails: true,
    })

    expect(results.downloadCount).toEqual({audio: 3, video: 3, thumbnail: 3})
    expect(results.videosDownloaded).toBeArrayOfSize(3)

    expect(fs.existsSync(`${mediaDir}/audio`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/video`)).toBeTrue()
    expect(fs.existsSync(`${mediaDir}/thumbnails`)).toBeTrue()

    const audioContents = fs.readdirSync(`${mediaDir}/audio`, {
      withFileTypes: true,
    })
    const videoContents = fs.readdirSync(`${mediaDir}/video`, {
      withFileTypes: true,
    })
    const thumbnailContents = fs.readdirSync(`${mediaDir}/thumbnails`, {
      withFileTypes: true,
    })

    expect(audioContents).toBeArrayOfSize(3)
    expect(videoContents).toBeArrayOfSize(3)
    expect(thumbnailContents).toBeArrayOfSize(3)
  })

  test('returned failures', async () => {})
})
