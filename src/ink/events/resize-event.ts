import { TerminalEvent } from './terminal-event.js'

/** A terminal viewport size change, measured in character cells. */
export class ResizeEvent extends TerminalEvent {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super('resize', { bubbles: false, cancelable: false })
    this.columns = columns
    this.rows = rows
  }
}
