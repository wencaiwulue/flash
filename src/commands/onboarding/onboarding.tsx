import React from 'react'
import { Onboarding } from '../../components/Onboarding.js'
import { completeOnboarding } from '../../interactiveHelpers.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  if (args.trim()) {
    onDone('Usage: /onboarding (this command does not accept arguments)')
    return null
  }

  let completed = false
  const handleDone = () => {
    if (completed) return
    completed = true
    completeOnboarding()
    onDone('Onboarding complete.')
  }

  return <Onboarding onDone={handleDone} />
}
