import {downloadYouTubePlaylist} from './src/main'
import minimist from 'minimist'
import path from 'node:path'

const {PLAYLIST_ID: playlistId, API_KEY: apiKey} = process.env
if (!playlistId) throw new Error('No PLAYLIST_ID env variable found')
if (!apiKey) throw new Error('No API_KEY env variable found')

const {audioOnly} = minimist<{audioOnly: boolean}>(Bun.argv, {
  boolean: ['audioOnly'],
})

const {failures, ...resultsMetadata} = await downloadYouTubePlaylist({
  playlistId,
  apiKey,
  audioOnly,
  getFullData: false,
  directory: path.resolve(import.meta.dir, './data'),
  downloadData: false,
})

console.log('RESULTS:')
console.table(resultsMetadata)

if (failures.length) {
  console.log('FAILURES:')
  console.table(failures)
}
