import { beforeEach, describe, expect, it } from 'bun:test'
import {
  getAutoCompactEnabled,
  getEditorMode,
  getFileCheckpointingEnabled,
  saveGlobalConfig,
} from '../src/utils/config.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// Upstream 2.1.311 "Any file" scope: the merged settings-file value is the
// primary source. flash additionally keeps a legacy ~/.claude.json value as a
// back-compat fallback (upstream's strict Any file semantics is settings-only;
// the fallback is a deliberate superset so existing ~/.claude.json users are not
// broken). The DISABLE_AUTO_COMPACT / CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
// env overrides are handled by the callers, not these helpers.
function setSettings(key: string, value: string | boolean | undefined): void {
  setSessionSettingsCache({
    settings: value === undefined ? {} : { [key]: value },
    errors: [],
  })
}

function setGlobal(key: string, value: string | boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, [key]: value }))
}

describe('getAutoCompactEnabled (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('autoCompactEnabled', undefined)
    setGlobal('autoCompactEnabled', undefined)
  })

  it('defaults to true when nothing sets it', () => {
    expect(getAutoCompactEnabled()).toBe(true)
  })

  it('settings-file value false overrides legacy config true', () => {
    setGlobal('autoCompactEnabled', true)
    setSettings('autoCompactEnabled', false)
    expect(getAutoCompactEnabled()).toBe(false)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('autoCompactEnabled', undefined)
    setGlobal('autoCompactEnabled', false)
    expect(getAutoCompactEnabled()).toBe(false)
  })
})

describe('getFileCheckpointingEnabled (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('fileCheckpointingEnabled', undefined)
    setGlobal('fileCheckpointingEnabled', undefined)
  })

  it('defaults to true when nothing sets it', () => {
    expect(getFileCheckpointingEnabled()).toBe(true)
  })

  it('settings-file value false overrides legacy config true', () => {
    setGlobal('fileCheckpointingEnabled', true)
    setSettings('fileCheckpointingEnabled', false)
    expect(getFileCheckpointingEnabled()).toBe(false)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('fileCheckpointingEnabled', undefined)
    setGlobal('fileCheckpointingEnabled', false)
    expect(getFileCheckpointingEnabled()).toBe(false)
  })
})

describe('getEditorMode (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('editorMode', undefined)
    setGlobal('editorMode', undefined)
  })

  it('defaults to normal when nothing sets it', () => {
    expect(getEditorMode()).toBe('normal')
  })

  it('settings-file value vim overrides legacy config normal', () => {
    setGlobal('editorMode', 'normal')
    setSettings('editorMode', 'vim')
    expect(getEditorMode()).toBe('vim')
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('editorMode', undefined)
    setGlobal('editorMode', 'vim')
    expect(getEditorMode()).toBe('vim')
  })
})
