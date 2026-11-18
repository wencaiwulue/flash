import { lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** Canonical error for memory path traversal and symlink escapes. */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

/** Resolve the deepest existing ancestor without allowing dangling links. */
function realpathDeepestExistingSync(absolutePath: string): string {
  const tail: string[] = []
  let current = absolutePath
  for (
    let parent = dirname(current);
    current !== parent;
    parent = dirname(current)
  ) {
    try {
      const resolved = realpathSync(current)
      return tail.length === 0 ? resolved : resolve(resolved, ...tail.reverse())
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'ENOENT') {
        try {
          if (lstatSync(current).isSymbolicLink()) {
            throw new PathTraversalError(`Dangling symlink detected: ${current}`)
          }
        } catch (lstatError) {
          if (lstatError instanceof PathTraversalError) throw lstatError
        }
      } else if (code === 'ELOOP') {
        throw new PathTraversalError(`Symlink loop detected: ${current}`)
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        throw new PathTraversalError(`Cannot verify path containment (${code}): ${current}`)
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  return absolutePath
}

/**
 * Execution-layer containment check. Lexical filtering runs first, then both
 * candidate and root are canonicalized so file and directory symlink escapes
 * fail closed. A missing root is allowed for first-time memory creation.
 */
export function validateRealPathContainmentSync(
  filePath: string,
  directory: string,
): string {
  if (filePath.includes('\0')) {
    throw new PathTraversalError('Null byte in memory path')
  }
  const candidate = resolve(filePath)
  const root = resolve(directory)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new PathTraversalError(`Path escapes memory directory: ${filePath}`)
  }

  const realCandidate = realpathDeepestExistingSync(candidate)
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return realCandidate
    throw new PathTraversalError(`Cannot verify memory directory (${code}): ${root}`)
  }
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new PathTraversalError(`Real path escapes memory directory: ${filePath}`)
  }
  return realCandidate
}

/** Boolean form for existing synchronous permission/path classifiers. */
export function isRealPathContainedSync(filePath: string, directory: string): boolean {
  try {
    validateRealPathContainmentSync(filePath, directory)
    return true
  } catch {
    return false
  }
}
