import downloadYouTubePlaylist from './src/main'
import minimist from 'minimist'

const playlistId = process.env.PLAYLIST_ID
if (!playlistId) throw new Error('No PLAYLIST_ID env variable found')

const {audioOnly} = minimist<{audioOnly: boolean}>(Bun.argv, {
  boolean: ['audioOnly'],
})

downloadYouTubePlaylist({playlistId, audioOnly})
