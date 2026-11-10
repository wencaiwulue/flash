import { collectContextData } from '../commands/context/context-noninteractive.js'
import type { AppState } from '../state/AppStateStore.js'
import {
  getFlagSettingsInline,
  setFlagSettingsInline,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getMainLoopModel } from './model/model.js'
import { stopTask } from '../tasks/stopTask.js'
import { getSettingsWithSources } from './settings/settings.js'
import { settingsChangeDetector } from './settings/changeDetector.js'
import { modelSupportsEffort, resolveAppliedEffort } from './effort.js'
import { notifySessionMetadataChanged } from './sessionState.js'
import { refreshActivePlugins } from './plugins/refresh.js'
import { loadAllPluginsCacheOnly } from './plugins/pluginLoader.js'
import { parseAgentsFromJson } from '../tools/AgentTool/loadAgentsDir.js'
import type { McpServerStatus } from '../entrypoints/sdk/coreTypes.js'
import type { SDKControlReloadPluginsResponse } from '../entrypoints/sdk/controlTypes.js'
import type { getCommands } from '../commands.js'

type SdkAppStateContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

export async function getSdkContextUsage(
  context: SdkAppStateContext & {
    messages: Parameters<typeof collectContextData>[0]['messages']
    tools: Parameters<typeof collectContextData>[0]['options']['tools']
    systemPrompt?: string
    appendSystemPrompt?: string
  },
) {
  const appState = context.getAppState()
  return collectContextData({
    messages: context.messages,
    getAppState: context.getAppState,
    options: {
      mainLoopModel: getMainLoopModel(),
      tools: context.tools,
      agentDefinitions: appState.agentDefinitions,
      customSystemPrompt: context.systemPrompt,
      appendSystemPrompt: context.appendSystemPrompt,
    },
  })
}

export function applySdkFlagSettings(settings: Record<string, unknown>): void {
  const previousModel = getMainLoopModel()
  const merged = { ...(getFlagSettingsInline() ?? {}), ...settings }
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key]
  }
  setFlagSettingsInline(merged)
  settingsChangeDetector.notifyChange('flagSettings')

  if ('model' in settings) {
    setMainLoopModelOverride(
      settings.model == null ? undefined : String(settings.model),
    )
  }
  const nextModel = getMainLoopModel()
  if (nextModel !== previousModel) {
    notifySessionMetadataChanged({ model: nextModel })
  }
}

export function getSdkSettings(
  appState: AppState,
): ReturnType<typeof getSettingsWithSources> & {
  applied: { model: string; effort: string | null }
} {
  const model = getMainLoopModel()
  const effort = modelSupportsEffort(model)
    ? resolveAppliedEffort(model, appState?.effortValue)
    : undefined
  return {
    ...getSettingsWithSources(),
    applied: {
      model,
      effort: typeof effort === 'string' ? effort : null,
    },
  }
}

export async function stopSdkTask(
  taskId: string,
  context: SdkAppStateContext,
): Promise<void> {
  await stopTask(taskId, context)
}

export async function reloadSdkPlugins(
  context: SdkAppStateContext & {
    cwd: string
    loadCommands: typeof getCommands
    mcpServers: McpServerStatus[]
    agents?: Parameters<typeof parseAgentsFromJson>[0]
  },
): Promise<SDKControlReloadPluginsResponse> {
  const result = await refreshActivePlugins(context.setAppState)
  const [commands, pluginState] = await Promise.all([
    context.loadCommands(context.cwd),
    loadAllPluginsCacheOnly(),
  ])
  const customAgents = parseAgentsFromJson(context.agents ?? {})
  return {
    commands: commands.map(command => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint || '',
    })),
    agents: [...result.agentDefinitions.allAgents, ...customAgents].map(agent => ({
      name: agent.agentType,
      description: agent.whenToUse,
      ...(agent.model === 'inherit' ? {} : { model: agent.model }),
    })),
    plugins: pluginState.enabled.map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      source: plugin.source,
    })),
    mcpServers: context.mcpServers,
    error_count: result.error_count,
  }
}
