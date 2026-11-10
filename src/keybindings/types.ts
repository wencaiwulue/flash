import type {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
} from './schema.js'

export type KeybindingContextName =
  | (typeof KEYBINDING_CONTEXTS)[number]
  | 'Scroll'
  | 'MessageActions'

export type KeybindingAction =
  | (typeof KEYBINDING_ACTIONS)[number]
  | 'scroll:pageUp'
  | 'scroll:pageDown'
  | 'scroll:lineUp'
  | 'scroll:lineDown'
  | 'scroll:top'
  | 'scroll:bottom'
  | 'selection:copy'
  | 'messageActions:prev'
  | 'messageActions:next'
  | 'messageActions:top'
  | 'messageActions:bottom'
  | 'messageActions:prevUser'
  | 'messageActions:nextUser'
  | 'messageActions:escape'
  | 'messageActions:ctrlc'
  | 'messageActions:enter'
  | 'messageActions:c'
  | 'messageActions:p'

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type ParsedBinding = {
  chord: Chord
  action: string | null
  context: KeybindingContextName
}
