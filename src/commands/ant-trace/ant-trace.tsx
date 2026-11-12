import React from 'react'
import { DiagnosticExportDialog } from '../../components/DiagnosticExportDialog.js'
import type {
  LocalJSXCommandCall,
} from '../../types/command.js'
import { writeNewDiagnosticJson } from '../../utils/diagnosticExport.js'
import {
  getLocalTraceExport,
  getLocalTraceStatus,
  startLocalTrace,
  stopLocalTrace,
} from './recorder.js'

const USAGE = 'Usage: /ant-trace start|stop|status|export <path>'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmed = args.trim()
  const [action, ...rest] = trimmed.split(/\s+/)
  if (!action || !['start', 'stop', 'status', 'export'].includes(action)) {
    onDone(USAGE)
    return null
  }

  if (action === 'start') {
    if (rest.length) {
      onDone(USAGE)
      return null
    }
    const result = startLocalTrace()
    onDone(
      result === 'already-started'
        ? 'Local trace recording is already active; existing bounds and buffer were preserved.'
        : 'Local trace recording started (bounded, process-local, no exporter or network enabled). Only new spans are recorded.',
    )
    return null
  }
  if (action === 'stop') {
    if (rest.length) {
      onDone(USAGE)
      return null
    }
    const result = await stopLocalTrace()
    onDone(
      result === 'not-started'
        ? 'Local trace recording was not active.'
        : 'Local trace recording stopped; the recorder was released and no new spans will be captured.',
    )
    return null
  }
  if (action === 'status') {
    if (rest.length) {
      onDone(USAGE)
      return null
    }
    const status = getLocalTraceStatus()
    onDone(
      `Local trace: ${status.recording ? 'recording' : 'stopped'}; spans=${status.spans}; active=${status.active}; dropped=${status.dropped}. No exporter is enabled by this command.`,
    )
    return null
  }

  const path = rest.join(' ').trim()
  if (!path) {
    onDone(USAGE)
    return null
  }
  const status = getLocalTraceStatus()
  return (
    <DiagnosticExportDialog
      title="Export local OpenTelemetry diagnostics"
      path={path}
      summary={[
        `Spans: ${status.spans}; dropped: ${status.dropped}; recording: ${status.recording ? 'yes' : 'no'}`,
        'Schema: allowlisted attributes, timing, and error categories only',
      ]}
      onExport={target =>
        writeNewDiagnosticJson(target, getLocalTraceExport())
      }
      onDone={onDone}
    />
  )
}
