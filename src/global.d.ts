/**
 * Global type declarations for the Claude Code project.
 *
 * This file provides ambient type declarations for modules that are
 * resolved at build time by Bun, as well as module declarations for
 * files imported without explicit extensions.
 */

// ---------------------------------------------------------------------------
// bun:bundle feature flags
//
// In the original Claude Code build, Bun's bundler uses `bun:bundle`
// for dead-code elimination. The `feature()` function returns a boolean
// that is resolved at build time. For development and type-checking,
// we stub it to always return false (all features disabled).
// ---------------------------------------------------------------------------

declare module 'bun:bundle' {
  /**
   * Feature flag for dead-code elimination.
   * In production builds, the bundler resolves this at compile time.
   * In development, always returns false.
   */
  export function feature(name: string): boolean
}

declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  FEEDBACK_CHANNEL: string
  ISSUES_EXPLAINER: string
}

declare module '*.txt' {
  const content: string
  export default content
}

declare module '*.md' {
  const content: string
  export default content
}

declare module 'bidi-js' {
  type BidiInstance = {
    getEmbeddingLevels(
      text: string,
      direction: 'auto' | 'ltr' | 'rtl',
    ): { levels: Uint8Array }
  }
  export default function bidiFactory(): BidiInstance
}

declare module 'image-processor-napi' {
  import type {
    SharpFunction,
  } from './tools/FileReadTool/imageProcessor.js'

  export const sharp: SharpFunction
  export const getNativeModule: () => {
    hasClipboardImage?: () => boolean
    readClipboardImage?: (
      maxWidth: number,
      maxHeight: number,
    ) => {
      png: Buffer
      originalWidth: number
      originalHeight: number
      width: number
      height: number
    } | null
  } | null
  const defaultExport: SharpFunction
  export default defaultExport
}

declare module 'url-handler-napi' {
  export function waitForUrlEvent(timeoutMs: number): string | null
}

declare module 'audio-capture-napi' {
  export function isNativeAudioAvailable(): boolean
  export function isNativeRecordingActive(): boolean
  export function startNativeRecording(
    onData: (chunk: Buffer) => void,
    onEnd: () => void,
  ): boolean
  export function stopNativeRecording(): void
}

// ---------------------------------------------------------------------------
// Module declarations for extension-less imports
//
// Bun resolves imports without explicit extensions. These declarations
// tell TypeScript that .ts/.tsx files can be imported with their
// runtime extension (.js) or without any extension.
// ---------------------------------------------------------------------------

declare module '*.css' {
  const content: string
  export default content
}

declare module '*.json' {
  const content: Record<string, unknown>
  export default content
}
