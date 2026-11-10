import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const axiosGet = mock()
const axiosPost = mock()

mock.module('axios', () => ({
  default: {
    get: axiosGet,
    post: axiosPost,
    isAxiosError: (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'isAxiosError' in error &&
      error.isAxiosError === true,
    isCancel: (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      '__CANCEL__' in error &&
      error.__CANCEL__ === true,
  },
}))

let workspace = ''
mock.module('../src/utils/cwd.ts', () => ({
  getCwd: () => workspace,
}))
mock.module('../src/services/analytics/index.ts', () => ({
  logEvent: mock(),
}))
mock.module('../src/utils/log.ts', () => ({
  logError: mock(),
}))
mock.module('../src/utils/debug.ts', () => ({
  logForDebugging: mock(),
}))

let runFilePersistence: typeof import('../src/utils/filePersistence/filePersistence.ts').runFilePersistence
let listFilesCreatedAfter: typeof import('../src/services/api/filesApi.ts').listFilesCreatedAfter

const sessionId = 'cloud-session'
const tokenEnv = 'CLAUDE_CODE_SESSION_ACCESS_TOKEN'
const sessionEnv = 'CLAUDE_CODE_REMOTE_SESSION_ID'
const kindEnv = 'CLAUDE_CODE_ENVIRONMENT_KIND'
const originalEnv = {
  [tokenEnv]: process.env[tokenEnv],
  [sessionEnv]: process.env[sessionEnv],
  [kindEnv]: process.env[kindEnv],
}

type ApiFile = {
  filename: string
  id: string
  size_bytes: number
}

function apiFile(filename: string, id: string, size: number): ApiFile {
  return { filename, id, size_bytes: size }
}

function listPage(data: ApiFile[], hasMore = false) {
  return {
    status: 200,
    data: { data, has_more: hasMore },
  }
}

function outputsDir(): string {
  return join(workspace, sessionId, 'outputs')
}

async function writeOutput(
  relativePath: string,
  content: string,
): Promise<{ path: string; size: number }> {
  const path = join(outputsDir(), relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return { path, size: Buffer.byteLength(content) }
}

function cloudConfig() {
  return {
    oauthToken: 'offline-token',
    sessionId,
    baseUrl: 'https://files.invalid',
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

beforeAll(async () => {
  ;({ runFilePersistence } = await import(
    '../src/utils/filePersistence/filePersistence.ts'
  ))
  ;({ listFilesCreatedAfter } = await import(
    '../src/services/api/filesApi.ts'
  ))
})

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'cloud-persistence-'))
  process.env[tokenEnv] = 'offline-token'
  process.env[sessionEnv] = sessionId
  process.env[kindEnv] = 'anthropic_cloud'
  axiosGet.mockReset()
  axiosPost.mockReset()
})

afterEach(async () => {
  restoreEnv(tokenEnv, originalEnv[tokenEnv])
  restoreEnv(sessionEnv, originalEnv[sessionEnv])
  restoreEnv(kindEnv, originalEnv[kindEnv])
  await rm(workspace, { recursive: true, force: true })
})

describe('Cloud file persistence', () => {
  test('matches normalized nested paths without confusing equal basenames', async () => {
    const nested = await writeOutput('nested/result.txt', 'nested')
    const other = await writeOutput('other/result.txt', 'other')
    axiosGet.mockResolvedValueOnce(
      listPage([
        apiFile('./nested/result.txt', 'file_nested', nested.size),
        apiFile('result.txt', 'file_basename_only', other.size),
        apiFile('other/result.txt', 'file_other', other.size),
      ]),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.failed).toEqual([])
    expect(result?.files).toHaveLength(2)
    expect(result?.files).toEqual(
      expect.arrayContaining([
        { filename: 'nested/result.txt', file_id: 'file_nested' },
        { filename: 'other/result.txt', file_id: 'file_other' },
      ]),
    )
    expect(axiosGet).toHaveBeenCalledTimes(1)
  })

  test('deduplicates repeated copies of the same path and file ID', async () => {
    const output = await writeOutput('duplicate.txt', 'same')
    axiosGet.mockResolvedValueOnce(
      listPage([
        apiFile('duplicate.txt', 'file_same', output.size),
        apiFile('./duplicate.txt', 'file_same', output.size),
      ]),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result).toEqual({
      files: [{ filename: 'duplicate.txt', file_id: 'file_same' }],
      failed: [],
    })
  })

  test('reports same-path different-ID ambiguity instead of using size or order', async () => {
    const good = await writeOutput('good.txt', 'good')
    const ambiguous = await writeOutput('ambiguous.txt', 'ambiguous')
    axiosGet.mockResolvedValueOnce(
      listPage([
        apiFile('good.txt', 'file_good', good.size),
        apiFile('ambiguous.txt', 'file_first', ambiguous.size),
        apiFile('ambiguous.txt', 'file_second', 999),
      ]),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([
      { filename: 'good.txt', file_id: 'file_good' },
    ])
    expect(result?.failed).toHaveLength(1)
    expect(result?.failed[0]?.filename).toBe('ambiguous.txt')
    expect(result?.failed[0]?.error).toContain('Ambiguous')
    expect(axiosGet).toHaveBeenCalledTimes(1)
  })

  test('rejects one file ID claiming multiple output paths', async () => {
    const first = await writeOutput('first.txt', 'first')
    const second = await writeOutput('second.txt', 'second')
    axiosGet.mockResolvedValueOnce(
      listPage([
        apiFile('first.txt', 'file_shared', first.size),
        apiFile('second.txt', 'file_shared', second.size),
      ]),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([])
    expect(result?.failed).toHaveLength(2)
    expect(result?.failed.every(file => file.error.includes('Ambiguous'))).toBe(
      true,
    )
  })

  test('uses size as an auxiliary integrity check after path matching', async () => {
    await writeOutput('size.txt', 'local-size')
    axiosGet.mockResolvedValueOnce(
      listPage([apiFile('size.txt', 'file_size', 1)]),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([])
    expect(result?.failed).toHaveLength(1)
    expect(result?.failed[0]?.error).toContain('size mismatch')
    expect(axiosGet).toHaveBeenCalledTimes(1)
  })

  test('retries missing metadata while the Cloud index catches up', async () => {
    const output = await writeOutput('delayed.txt', 'delayed')
    axiosGet
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(listPage([]))
      .mockResolvedValueOnce(
        listPage([apiFile('delayed.txt', 'file_delayed', output.size)]),
      )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result).toEqual({
      files: [{ filename: 'delayed.txt', file_id: 'file_delayed' }],
      failed: [],
    })
    expect(axiosGet).toHaveBeenCalledTimes(3)
  })

  test('keeps partial successes and fails unmatched files after bounded retries', async () => {
    const good = await writeOutput('good.txt', 'good')
    await writeOutput('missing.txt', 'missing')
    const page = listPage([apiFile('good.txt', 'file_good', good.size)])
    axiosGet
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([
      { filename: 'good.txt', file_id: 'file_good' },
    ])
    expect(result?.failed).toHaveLength(1)
    expect(result?.failed[0]?.filename).toBe('missing.txt')
    expect(result?.failed[0]?.error).toContain('after 3 attempts')
    expect(axiosGet).toHaveBeenCalledTimes(3)
  })

  test('fails modified files when the Files API throws', async () => {
    await writeOutput('offline.txt', 'offline')
    axiosGet.mockRejectedValueOnce(new Error('offline mock failure'))

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([])
    expect(result?.failed).toHaveLength(1)
    expect(result?.failed[0]?.filename).toBe('offline.txt')
    expect(result?.failed[0]?.error).toContain('offline mock failure')
  })

  test('rejects interrupted pagination instead of returning partial metadata', async () => {
    axiosGet.mockResolvedValueOnce(listPage([], true))

    await expect(
      listFilesCreatedAfter(new Date().toISOString(), cloudConfig()),
    ).rejects.toThrow('pagination interrupted')
    expect(axiosGet).toHaveBeenCalledTimes(1)
  })

  test('does not call the API or record a failure when already aborted', async () => {
    await writeOutput('aborted.txt', 'aborted')
    const controller = new AbortController()
    controller.abort()

    const result = await runFilePersistence(
      Date.now() - 1_000,
      controller.signal,
    )

    expect(result).toBeNull()
    expect(axiosGet).not.toHaveBeenCalled()
  })

  test('cancels an in-flight list request without recording failures', async () => {
    await writeOutput('aborted.txt', 'aborted')
    axiosGet.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('canceled')
              Object.assign(error, { __CANCEL__: true })
              reject(error)
            },
            { once: true },
          )
        }),
    )
    const controller = new AbortController()

    const pendingResult = runFilePersistence(
      Date.now() - 1_000,
      controller.signal,
    )
    while (axiosGet.mock.calls.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    controller.abort()

    expect(await pendingResult).toBeNull()
  })

  test('does not call the API when no outputs were modified', async () => {
    const output = await writeOutput('old.txt', 'old')
    const oldDate = new Date(Date.now() - 10_000)
    await utimes(output.path, oldDate, oldDate)

    const result = await runFilePersistence(Date.now())

    expect(result).toBeNull()
    expect(axiosGet).not.toHaveBeenCalled()
  })

  test('enforces the modified-file count limit before listing', async () => {
    await mkdir(outputsDir(), { recursive: true })
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        writeOutput(`file-${index}.txt`, ''),
      ),
    )

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result?.files).toEqual([])
    expect(result?.failed).toHaveLength(1)
    expect(result?.failed[0]?.error).toContain('1001')
    expect(axiosGet).not.toHaveBeenCalled()
  })

  test('ignores output symlinks without calling the API', async () => {
    const outside = join(workspace, 'outside.txt')
    await writeFile(outside, 'outside')
    await mkdir(outputsDir(), { recursive: true })
    await symlink(outside, join(outputsDir(), 'link.txt'))

    const result = await runFilePersistence(Date.now() - 1_000)

    expect(result).toBeNull()
    expect(axiosGet).not.toHaveBeenCalled()
  })
})
