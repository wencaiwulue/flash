import React from 'react'
import { getMockLimitsBanner } from '../services/mockRateLimits.js'
import { Box, Text } from '../ink.js'

/** Persistent while process-local response mocking is active. */
export function MockLimitsBanner(): React.ReactNode {
  const banner = getMockLimitsBanner()
  if (!banner) return null
  return (
    <Box marginTop={1}>
      <Text color="warning" bold>{banner}</Text>
    </Box>
  )
}
