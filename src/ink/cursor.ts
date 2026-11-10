export type Cursor = {
  /** Zero-based terminal cell column. */
  x: number
  /** Zero-based row in the rendered screen. */
  y: number
  visible: boolean
}
