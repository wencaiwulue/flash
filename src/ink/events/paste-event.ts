import { TerminalEvent } from './terminal-event.js'

/** Text pasted into the terminal, including bracketed-paste contents. */
export class PasteEvent extends TerminalEvent {
  readonly text: string

  constructor(text: string) {
    super('paste', { bubbles: true, cancelable: true })
    this.text = text
  }
}
