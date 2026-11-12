import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import {
  captureTungstenSession,
  getTungstenActiveCommand,
  listTungstenSessions,
  type TungstenSession,
} from './utils.js'

type Snapshot = {
  sessions: TungstenSession[]
  capture: string
  command: string
}

export function TungstenLiveMonitor(): React.ReactNode {
  const active = useAppState(state => state.tungstenActiveSession)
  const autoHidden = useAppState(state => state.tungstenPanelAutoHidden)
  const visible = useAppState(state => state.tungstenPanelVisible)
  const lastCommand = useAppState(state => state.tungstenLastCommand)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionName = active?.sessionName

  useEffect(() => {
    if (!sessionName || autoHidden || visible === false) {
      setSnapshot(null)
      setError(null)
      return
    }
    let disposed = false
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling || disposed) return
      polling = true
      try {
        const [sessions, capture, command] = await Promise.all([
          listTungstenSessions(),
          captureTungstenSession(sessionName, 30),
          getTungstenActiveCommand(sessionName),
        ])
        if (!disposed) {
          setSnapshot({ sessions, capture, command })
          setError(null)
        }
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 1000)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [sessionName, autoHidden, visible])

  if (!active || autoHidden || visible === false) return null
  const children = [
    React.createElement(
      Text,
      { bold: true, key: 'title' },
      `tmux: ${active.sessionName}${snapshot?.command ? ` (${snapshot.command})` : ''}`,
    ),
    snapshot
      ? React.createElement(
          Text,
          { dimColor: true, key: 'sessions' },
          snapshot.sessions.map(session => session.name).join(', ') || 'No sessions',
        )
      : null,
    lastCommand
      ? React.createElement(
          Text,
          { dimColor: true, key: 'last-command' },
          `Last input: ${lastCommand.command}`,
        )
      : null,
    snapshot?.capture
      ? React.createElement(Text, { key: 'capture' }, snapshot.capture.trimEnd())
      : null,
    error
      ? React.createElement(
          Text,
          { color: 'warning', key: 'error' },
          `tmux refresh failed: ${error}`,
        )
      : null,
  ]
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    ...children,
  )
}
