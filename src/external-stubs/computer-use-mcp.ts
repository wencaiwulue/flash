import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type {
  ComputerUseCapabilities,
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  ComputerUseTool,
  CoordinateMode,
  CuCallToolResult,
} from './computer-use-types.js'
import { privatePackageUnavailable } from './unavailable.js'

export * from './computer-use-types.js'

export type ImageResizeParams = {
  maxWidth: number
  maxHeight: number
  maxPixels: number
}

/** Anthropic's computer-use image constraints: long edge and total pixels. */
export const API_RESIZE_PARAMS: Readonly<ImageResizeParams> = Object.freeze({
  maxWidth: 1568,
  maxHeight: 1568,
  maxPixels: 1_150_000,
})

/** Preserve aspect ratio while satisfying both edge and pixel-budget limits. */
export function targetImageSize(
  width: number,
  height: number,
  params: ImageResizeParams,
): [number, number] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError('Image dimensions must be finite positive numbers')
  }
  const scale = Math.min(
    1,
    params.maxWidth / width,
    params.maxHeight / height,
    Math.sqrt(params.maxPixels / (width * height)),
  )
  return [Math.round(width * scale), Math.round(height * scale)]
}

/**
 * Discovery is deliberately empty in the external build. No computer-use tools
 * are advertised, so the model cannot mistake the disabled boundary for a
 * working implementation.
 */
export function buildComputerUseTools(
  _capabilities: ComputerUseCapabilities,
  _coordinateMode: CoordinateMode,
  _installedAppNames?: string[],
): ComputerUseTool[] {
  return []
}

export function bindSessionContext(
  _adapter: ComputerUseHostAdapter,
  _coordinateMode: CoordinateMode,
  _context: ComputerUseSessionContext,
): (name: string, args: unknown) => Promise<CuCallToolResult> {
  throw privatePackageUnavailable('@ant/computer-use-mcp')
}

export function createComputerUseMcpServer(
  _adapter: ComputerUseHostAdapter,
  _coordinateMode: CoordinateMode,
): Server {
  throw privatePackageUnavailable('@ant/computer-use-mcp')
}
