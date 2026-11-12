import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { isInProtectedNamespace } from '../src/utils/envUtils.ts'
import { checkProtectedNamespace } from '../src/utils/protectedNamespace.ts'

const ENV_KEYS = [
  'USER_TYPE',
  'COO_RUNNING_ON_HOMESPACE',
  'COO_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBERNETES_NAMESPACE',
  'CLAUDE_CODE_KUBERNETES_NAMESPACE',
  'CLAUDE_CODE_KUBERNETES_NAMESPACE_PATH',
  'CLAUDE_CODE_ALLOWED_NAMESPACES',
] as const

let original: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.USER_TYPE = 'external'
  tempDir = await mkdtemp(join(tmpdir(), 'claude-namespace-'))
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('public protected namespace detection', () => {
  test('returns false with no environment signals, including external REPL use', () => {
    expect(checkProtectedNamespace()).toBe(false)
    expect(isInProtectedNamespace()).toBe(false)
  })

  test('honors exact configurable allowlist matches', () => {
    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE = 'development'
    process.env.CLAUDE_CODE_ALLOWED_NAMESPACES = 'development, sandbox'
    expect(checkProtectedNamespace()).toBe(false)

    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE = 'production'
    expect(checkProtectedNamespace()).toBe(true)
  })

  test('treats homespace as explicitly local', () => {
    process.env.COO_RUNNING_ON_HOMESPACE = 'true'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(checkProtectedNamespace()).toBe(false)
  })

  test('fails safe for empty or ambiguous namespace values', () => {
    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE = '  '
    process.env.CLAUDE_CODE_ALLOWED_NAMESPACES = 'development'
    expect(checkProtectedNamespace()).toBe(true)

    process.env.COO_RUNNING_ON_HOMESPACE = 'false'
    delete process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE
    expect(checkProtectedNamespace()).toBe(true)
  })

  test('reads the public Kubernetes serviceaccount namespace file', async () => {
    const namespacePath = join(tempDir!, 'namespace')
    await writeFile(namespacePath, 'sandbox\n')
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE_PATH = namespacePath
    process.env.CLAUDE_CODE_ALLOWED_NAMESPACES = 'sandbox'
    expect(checkProtectedNamespace()).toBe(false)

    await writeFile(namespacePath, 'restricted\n')
    expect(checkProtectedNamespace()).toBe(true)
  })

  test('fails safe on namespace I/O errors after a Kubernetes signal', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.CLAUDE_CODE_KUBERNETES_NAMESPACE_PATH = join(
      tempDir!,
      'missing',
    )
    process.env.CLAUDE_CODE_ALLOWED_NAMESPACES = 'sandbox'
    expect(checkProtectedNamespace()).toBe(true)
  })
})
