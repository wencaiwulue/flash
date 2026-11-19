// Root cause evidence: source form is unrunnable in this repo
// Error line: error: Cannot find module './tools/REPLTool/REPLTool.js' from 'src/tools.ts'
// 2026-11-18 修订：源码形态在本仓库不可运行（USER_TYPE=ant 需要 ant 专属私有模块 REPLTool.js 等，快照中不存在，探针证据 src/tools.ts:16-22）
// All tests blocked-by-prereq:source-form-missing-ant-modules

import { describe, test, afterAll } from 'bun:test'
import { skipLine } from './form/launcher'

const toClose = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

describe('managed-security', () => {
  // Scenario: managed-security:normal-override
  // What WOULD be tested: sanity check that managed settings override user settings
  test.skip('managed-security:normal-override (blocked-by-prereq:source-form-missing-ant-modules)', () => {})
  console.log(skipLine('blocked-by-prereq:source-form-missing-ant-modules', 'managed-security:normal-override'))

  // Scenario: managed-security:corrupt-json
  // What WOULD be tested: probe behavior with corrupt managed settings (fail-closed security requirement)
  test.skip('managed-security:corrupt-json (blocked-by-prereq:source-form-missing-ant-modules)', () => {})
  console.log(skipLine('blocked-by-prereq:source-form-missing-ant-modules', 'managed-security:corrupt-json'))

  // Scenario: managed-security:dangerous-permissions-bypass
  // What WOULD be tested: probe that managed deny rules are enforced and can't be bypassed by user settings
  test.skip('managed-security:dangerous-permissions-bypass (blocked-by-prereq:source-form-missing-ant-modules)', () => {})
  console.log(skipLine('blocked-by-prereq:source-form-missing-ant-modules', 'managed-security:dangerous-permissions-bypass'))
})
