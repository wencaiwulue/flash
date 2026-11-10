import React from 'react'
import { mkdir, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { startDaemon } from '../../daemon/main.js'
import { Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'

export async function computeDefaultInstallDir(): Promise<string> {
  return join(homedir(), '.claude', 'assistant')
}

type Props = {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

export function NewInstallWizard({
  defaultDir,
  onInstalled,
  onCancel,
  onError,
}: Props): React.ReactNode {
  const install = async () => {
    try {
      await mkdir(defaultDir, { recursive: true, mode: 0o700 })
      await writeFile(
        join(defaultDir, 'daemon.json'),
        JSON.stringify({ version: 1, installedAt: new Date().toISOString() }),
        { mode: 0o600 },
      )
      await startDaemon('assistant')
      onInstalled(defaultDir)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <Dialog title="Install the assistant daemon" onCancel={onCancel}>
      <Text dimColor>Install location: {defaultDir}</Text>
      <Select
        options={[
          { label: 'Install and start', value: 'install' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={value => {
          if (value === 'install') void install()
          else onCancel()
        }}
      />
    </Dialog>
  )
}
