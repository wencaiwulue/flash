import { fileURLToPath } from 'url'

export type Commit = {
  full: string
  short: string
  date: string
  subject: string
}

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export function git(args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', REPOSITORY_ROOT, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

let cachedCommits: Commit[] | undefined

export function commits(): Commit[] {
  if (cachedCommits) return cachedCommits
  cachedCommits = git(['log', '--reverse', '--topo-order', '--format=%H%x09%h%x09%cI%x09%s'])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [full, short, date, ...subject] = line.split('\t')
      return { full: full!, short: short!, date: date!, subject: subject.join('\t') }
    })
  return cachedCommits
}

export type ChangedFile = {
  status: string
  path: string
  oldPath?: string
}

export function changedFiles(commit: string): ChangedFile[] {
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).split(' ')
  // Merge records document the change introduced on the first-parent line.
  const output = parents.length > 2
    ? git(['diff', '--name-status', '-M', `${commit}^1`, commit])
    : git([
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-M',
        commit,
      ])
  if (!output) return []
  return output.split('\n').map(line => {
    const [status, first, second] = line.split('\t')
    if (status!.startsWith('R')) {
      return { status: status!, path: second!, oldPath: first! }
    }
    return { status: status!, path: first! }
  })
}

export function fileAtRevision(revision: string, path: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', REPOSITORY_ROOT, 'show', `${revision}:${path}`],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0 ? result.stdout.toString() : undefined
}
