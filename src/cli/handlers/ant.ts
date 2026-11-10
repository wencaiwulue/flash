import type { Command as CommanderCommand } from '@commander-js/extra-typings'

function unavailable(command: string): Error {
  return new Error(`${command} is unavailable in this external build.`)
}

export async function logHandler(
  _logId: string | number | undefined,
): Promise<void> {
  throw unavailable('The log command')
}

export async function errorHandler(
  _number: number | undefined,
): Promise<void> {
  throw unavailable('The error command')
}

export async function exportHandler(
  _source: string,
  _outputFile: string,
): Promise<void> {
  throw unavailable('The export command')
}

export async function taskCreateHandler(
  _subject: string,
  _options: { description?: string; list?: string },
): Promise<void> {
  throw unavailable('Task management')
}

export async function taskListHandler(_options: {
  list?: string
  pending?: boolean
  json?: boolean
}): Promise<void> {
  throw unavailable('Task management')
}

export async function taskGetHandler(
  _id: string,
  _options: { list?: string },
): Promise<void> {
  throw unavailable('Task management')
}

export async function taskUpdateHandler(
  _id: string,
  _options: {
    list?: string
    status?: string
    subject?: string
    description?: string
    owner?: string
    clearOwner?: boolean
  },
): Promise<void> {
  throw unavailable('Task management')
}

export async function taskDirHandler(_options: {
  list?: string
}): Promise<void> {
  throw unavailable('Task management')
}

export async function completionHandler(
  _shell: string,
  _options: { output?: string },
  _program: CommanderCommand,
): Promise<void> {
  throw unavailable('Shell completion generation')
}
