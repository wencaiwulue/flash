import packageJson from '../package.json'

// Bun's production build replaces MACRO.* at compile time. Direct source
// execution (SDK consumers, tests, `bun run dev`) needs the same defaults.
if (typeof MACRO === 'undefined') {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: packageJson.version,
      BUILD_TIME: '',
      PACKAGE_URL: `https://www.npmjs.com/package/${packageJson.name}`,
      NATIVE_PACKAGE_URL: `https://www.npmjs.com/package/${packageJson.name}`,
      VERSION_CHANGELOG: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
    },
  })
}
