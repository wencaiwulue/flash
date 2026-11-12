import { chmod } from 'node:fs/promises'
import packageJson from '../package.json'
import { generateSdkTypes } from './generate-sdk-types.ts'
import { EXTERNAL_FEATURES } from './externalFeatureProfile.ts'

generateSdkTypes()

const outdir = process.env.BUILD_OUTDIR ?? 'dist'
const packageUrl = `https://www.npmjs.com/package/${packageJson.name}`
const define = {
  'MACRO.VERSION': JSON.stringify(packageJson.version),
  'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
  'MACRO.PACKAGE_URL': JSON.stringify(packageUrl),
  'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(packageUrl),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify(''),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(''),
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
}

const builds = [
  {
    entrypoints: ['src/entrypoints/cli.tsx'],
    naming: { entry: 'main.[ext]' },
    banner: '#!/usr/bin/env bun',
  },
  {
    entrypoints: ['src/entrypoints/agentSdkTypes.ts'],
    naming: { entry: 'sdk.mjs' },
  },
] as const

for (const build of builds) {
  const result = await Bun.build({
    ...build,
    outdir,
    target: 'bun',
    format: 'esm',
    features: [...EXTERNAL_FEATURES],
    define,
    loader: {
      '.md': 'text',
      '.txt': 'text',
    },
  })

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  for (const output of result.outputs) {
    console.log(`${output.path}`)
  }
}

await chmod(`${outdir}/main.js`, 0o755)
