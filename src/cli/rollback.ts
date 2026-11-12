import { homedir } from 'os'
import { getLatestVersionFromGcs } from '../utils/autoUpdater.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { installLatest } from '../utils/nativeInstaller/index.js'
import { writeToStderr, writeToStdout } from '../utils/process.js'

export type PublishedVersion = { version: string; publishedAt?: string }
export type RollbackOptions = {
  list?: boolean
  dryRun?: boolean
  safe?: boolean
}
export type RollbackDependencies = {
  getVersions: () => Promise<PublishedVersion[]>
  getSafeVersion: () => Promise<string | null>
  install: (version: string) => Promise<{
    latestVersion: string | null
    wasUpdated: boolean
    lockFailed?: boolean
    lockHolderPid?: number
  }>
  currentVersion: string
}

async function getPublishedVersions(): Promise<PublishedVersion[]> {
  const packageName = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL
  // Run outside the workspace so project .npmrc files cannot redirect this
  // security-sensitive release lookup to an untrusted registry.
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageName, 'versions', 'time', '--json', '--prefer-online'],
    { cwd: homedir(), abortSignal: AbortSignal.timeout(30_000) },
  )
  if (result.code !== 0) {
    throw new Error(`Unable to read published versions: ${result.stderr.trim() || `npm exited ${result.code}`}`)
  }
  const parsed = JSON.parse(result.stdout) as {
    versions?: unknown
    time?: Record<string, string>
  }
  if (!Array.isArray(parsed.versions)) throw new Error('Release metadata has no versions array.')
  return parsed.versions
    .filter((version): version is string => typeof version === 'string')
    .reverse()
    .map(version => ({ version, publishedAt: parsed.time?.[version] }))
}

const productionDependencies: RollbackDependencies = {
  getVersions: getPublishedVersions,
  getSafeVersion: () => getLatestVersionFromGcs('stable'),
  install: version => installLatest(version, false),
  currentVersion: MACRO.VERSION,
}

function fail(message: string): void {
  process.exitCode = 1
  writeToStderr(`Error: ${message}\n`)
}

function formatAge(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const milliseconds = Date.now() - Date.parse(timestamp)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return timestamp
  const days = Math.floor(milliseconds / 86_400_000)
  if (days > 0) return `${days}d ago`
  const hours = Math.floor(milliseconds / 3_600_000)
  if (hours > 0) return `${hours}h ago`
  return `${Math.floor(milliseconds / 60_000)}m ago`
}

export async function rollback(
  target?: string,
  options: RollbackOptions = {},
  dependencies: RollbackDependencies = productionDependencies,
): Promise<void> {
  if (options.safe && target) {
    fail('--safe cannot be combined with an explicit target.')
    return
  }
  if (options.safe && options.list) {
    fail('--safe cannot be combined with --list.')
    return
  }

  let versions: PublishedVersion[] = []
  if (!options.safe) {
    try {
      versions = await dependencies.getVersions()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
  }
  if (options.list) {
    if (versions.length === 0) {
      fail('No published versions were returned.')
      return
    }
    writeToStdout(
      `${versions
        .slice(0, 100)
        .map(({ version, publishedAt }) => {
          const current = version === dependencies.currentVersion ? ' (current)' : ''
          const age = formatAge(publishedAt)
          return `${version}${current}${age ? `\t${age}` : ''}`
        })
        .join('\n')}\n`,
    )
    return
  }

  let selected: string | null
  if (options.safe) {
    try {
      selected = await dependencies.getSafeVersion()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    if (!selected) {
      fail('The public stable channel did not provide a safe version.')
      return
    }
  } else if (target === undefined || /^\d+$/.test(target)) {
    const offset = target === undefined ? 1 : Number(target)
    if (!Number.isSafeInteger(offset) || offset < 1) {
      fail('Relative rollback target must be a positive integer.')
      return
    }
    const currentIndex = versions.findIndex(
      item => item.version === dependencies.currentVersion,
    )
    selected = currentIndex < 0
      ? versions[offset - 1]?.version ?? null
      : versions[currentIndex + offset]?.version ?? null
    if (!selected) {
      fail(`No published version exists ${offset} release(s) before ${dependencies.currentVersion}.`)
      return
    }
  } else {
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(target)) {
      fail('Invalid version target.')
      return
    }
    selected = versions.some(item => item.version === target) ? target : null
    if (!selected) {
      fail(`Published version not found: ${target}`)
      return
    }
  }

  if (selected === dependencies.currentVersion) {
    writeToStdout(`Already running ${selected}; no rollback is needed.\n`)
    return
  }
  writeToStdout(`Rollback target: ${dependencies.currentVersion} → ${selected}\n`)
  if (options.dryRun) {
    writeToStdout('Dry run: no files or installation links were changed.\n')
    return
  }
  try {
    const result = await dependencies.install(selected)
    if (result.lockFailed || !result.latestVersion) {
      fail(
        result.lockFailed
          ? `Another Claude process${result.lockHolderPid ? ` (PID ${result.lockHolderPid})` : ''} is installing a release.`
          : `Native installation of ${selected} failed; the previous installation was retained.`,
      )
      return
    }
    writeToStdout(`Rolled back to ${result.latestVersion}.\n`)
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\nThe previous installation was retained where the installer could guarantee atomic recovery.`,
    )
  }
}
