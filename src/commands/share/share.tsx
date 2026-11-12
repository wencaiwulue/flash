import React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { ShareDialog } from './ShareDialog.js'
import { getSharePreview } from './shareHtml.js'

function defaultHtmlFilename(now = new Date()): string {
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replaceAll(/\.\d{3}Z$/, 'Z')
  return `conversation-${timestamp}.html`
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => (
  <ShareDialog
    messages={context.messages}
    initialFilename={args.trim()}
    defaultFilename={defaultHtmlFilename()}
    preview={getSharePreview(context.messages)}
    onDone={onDone}
  />
)
