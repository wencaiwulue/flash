import React from 'react'
import { Text } from '../../ink.js'

export function TungstenLiveMonitor(): React.ReactNode {
  return React.createElement(
    Text,
    { dimColor: true },
    'Tungsten monitoring is unavailable in this build.',
  )
}
