import fs from 'node:fs'
import {Video, downloadAllVideos, getExistingAudioIds} from './utils'

const {PLAYLIST_ID} = process.env
const existingIds = getExistingAudioIds()
const videos: Video[] = await Bun.file(`./data/${PLAYLIST_ID}_videos.json`, {
  type: 'application/json',
}).json()

if (!fs.existsSync('data/audio')) fs.mkdirSync('data/audio')

await downloadAllVideos(videos, existingIds)
