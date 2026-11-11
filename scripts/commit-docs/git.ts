import { fileURLToPath } from 'url'
import type { Commit } from './schema.ts'

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

export function commits(): Commit[] {
  const revisions = git(['rev-list', '--reverse', '--topo-order', 'HEAD'])
    .split('\n')
    .filter(Boolean)
  return revisions.map(full => {
    const line = git(['show', '-s', '--format=%cI%x09%s', full])
    const [date, ...subject] = line.split('\t')
    return { full, short: full.slice(0, 7), date: date!, subject: subject.join('\t') }
  })
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
