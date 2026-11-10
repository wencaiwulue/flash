// Re-export the source-of-truth settings type until the JSON schema generator
// is restored. This keeps the public SDK type aligned with CLI validation.
export type { SettingsJson as Settings } from '../../utils/settings/types.js'
