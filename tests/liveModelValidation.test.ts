import { expect, test } from 'bun:test'
import { validateCredentialSources } from '../scripts/live-model-validation'

test('validateCredentialSources returns null when no credentials', () => {
  expect(validateCredentialSources({})).toBeNull()
})

test('validateCredentialSources returns "api_key" when only ANTHROPIC_API_KEY is present', () => {
  expect(validateCredentialSources({ ANTHROPIC_API_KEY: 'sk-ant-...' })).toBe('api_key')
})

test('validateCredentialSources returns "bearer" when only ANTHROPIC_AUTH_TOKEN is present', () => {
  expect(validateCredentialSources({ ANTHROPIC_AUTH_TOKEN: 'secret-token' })).toBe('bearer')
})

test('validateCredentialSources throws when both credentials are present', () => {
  expect(() => validateCredentialSources({
    ANTHROPIC_API_KEY: 'sk-ant-...',
    ANTHROPIC_AUTH_TOKEN: 'secret-token'
  })).toThrow('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are mutually exclusive')
})

test('validateCredentialSources does not include actual secrets in error messages', () => {
  const apiKey = 'sk-ant-actual-secret-12345'
  const authToken = 'actual-bearer-token-67890'

  let thrownError: Error | undefined
  try {
    validateCredentialSources({
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_AUTH_TOKEN: authToken
    })
  } catch (error) {
    thrownError = error as Error
  }

  expect(thrownError).toBeDefined()
  expect(thrownError?.message).not.toInclude(apiKey)
  expect(thrownError?.message).not.toInclude(authToken)
})
