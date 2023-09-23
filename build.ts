import dts from 'bun-plugin-dts'

await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  target: 'bun',
  external: ['@googleapis/youtube'],
  plugins: [dts()],
})
