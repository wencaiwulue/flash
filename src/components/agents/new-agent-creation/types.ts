import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import type { CustomAgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { SettingSource } from '../../../utils/settings/constants.js'

type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

export type AgentWizardData = {
  location?: SettingSource
  method?: 'generate' | 'manual'
  generationPrompt?: string
  isGenerating?: boolean
  wasGenerated?: boolean
  agentType?: string
  whenToUse?: string
  systemPrompt?: string
  generatedAgent?: GeneratedAgent
  selectedTools?: string[]
  selectedModel?: string
  selectedColor?: string
  selectedMemory?: AgentMemoryScope
  finalAgent?: CustomAgentDefinition
}
