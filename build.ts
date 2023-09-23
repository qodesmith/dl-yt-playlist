import dts from 'bun-plugin-dts'

const start = performance.now()

await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  target: 'bun',
  external: ['@googleapis/youtube'],
  plugins: [dts()],
})

const totalTime = ((performance.now() - start) / 1000).toFixed(2)
console.log(`Finished building in ${totalTime} seconds`)
