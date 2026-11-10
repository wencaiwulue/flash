/** Timestamp type for file persistence operations */
export type TurnStartTime = number

export interface PersistedFile {
  filename: string
  file_id: string
}

export interface FailedPersistence {
  filename: string
  error: string
}

export interface FilesPersistedEventData {
  files: PersistedFile[]
  failed: FailedPersistence[]
}

/** Subdirectory name for output files */
export const OUTPUTS_SUBDIR = 'outputs'

/** Default concurrency for file uploads */
export const DEFAULT_UPLOAD_CONCURRENCY = 5

/** Maximum number of files to persist per turn */
export const FILE_COUNT_LIMIT = 1000
