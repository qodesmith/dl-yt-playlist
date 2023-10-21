import downloadYouTubePlaylist from './src/main'
import minimist from 'minimist'

const {PLAYLIST_ID: playlistId, API_KEY: apiKey} = process.env
if (!playlistId) throw new Error('No PLAYLIST_ID env variable found')
if (!apiKey) throw new Error('No API_KEY env variable found')

const {audioOnly} = minimist<{audioOnly: boolean}>(Bun.argv, {
  boolean: ['audioOnly'],
})

downloadYouTubePlaylist({playlistId, apiKey, audioOnly, getFullData: true})
