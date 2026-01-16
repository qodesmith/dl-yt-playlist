import dts from 'bun-plugin-dts'

import pkgJson from './package.json'

const start = performance.now()

await Bun.build({
  entrypoints: ['./src/main.ts', './src/schemas.ts'],
  outdir: './dist',
  target: 'bun',
  external: Object.keys(pkgJson.dependencies),
  plugins: [dts()],
})

const totalTime = ((performance.now() - start) / 1000).toFixed(2)
// biome-ignore lint/suspicious/noConsole: it's ok
console.log(`Finished building in ${totalTime} seconds`)
