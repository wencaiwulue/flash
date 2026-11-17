import React from 'react'
import { Text } from '../ink.js'
import type { ValidationError } from '../utils/settings/validation.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { ValidationErrorsList } from './ValidationErrorsList.js'

type Props = {
  settingsErrors: ValidationError[]
  onContinue: () => void
  onExit: () => void
}

/**
 * Dialog shown when settings files have validation errors.
 * User must choose to continue (skipping invalid files) or exit to fix them.
 */
export function InvalidSettingsDialog({
  settingsErrors,
  onContinue,
  onExit,
}: Props): React.ReactNode {
  const hasErrors = settingsErrors.some(error => error.severity !== 'warning')

  function handleSelect(value: string): void {
    if (value === 'exit') {
      onExit()
    } else {
      onContinue()
    }
  }

  return (
    <Dialog
      title={hasErrors ? 'Settings Error' : 'Settings Warning'}
      onCancel={hasErrors ? onExit : onContinue}
      color="warning"
    >
      <ValidationErrorsList errors={settingsErrors} />
      <Text dimColor>
        {hasErrors
          ? 'Files with errors are skipped entirely, not just the invalid settings.'
          : 'Invalid entries were skipped; valid settings remain active.'}
      </Text>
      <Select
        options={hasErrors
          ? [
              { label: 'Exit and fix manually', value: 'exit' },
              {
                label: 'Continue without these settings',
                value: 'continue',
              },
            ]
          : [{ label: 'Continue', value: 'continue' }]}
        onChange={handleSelect}
        onCancel={hasErrors ? onExit : onContinue}
      />
    </Dialog>
  )
}
