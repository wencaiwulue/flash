import type { BaseHookInput } from '../entrypoints/agentSdkTypes.js'

export type FileSuggestionCommandInput = BaseHookInput & {
  query: string
}
