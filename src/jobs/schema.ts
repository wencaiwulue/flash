import { z } from 'zod'

export const LOCAL_TEMPLATE_JOBS_VERSION = 'local-template-jobs-v1' as const
export const JOB_ENV_KEY = 'CLAUDE_JOB_DIR'

const uuid = z.string().uuid()
const timestamp = z.string().datetime({ offset: true })

export const templateConfigSchema = z
  .object({
    description: z.string().nullable(),
    model: z.string().nullable(),
    permission_mode: z.enum(['default', 'acceptEdits', 'plan']),
    allowed_tools: z.array(z.string()).nullable(),
    cwd: z.string(),
  })
  .strict()

export const templateSnapshotSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    source_path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    body: z.string(),
    config: templateConfigSchema,
  })
  .strict()

export const jobRecordSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    job_id: uuid,
    session_id: uuid,
    request_id: uuid,
    created_at: timestamp,
    cwd: z.string(),
    template: templateSnapshotSchema,
    transcript_path: z.string(),
    initial_prompt: z.string(),
    rendered_prompt: z.string(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const jobClassificationSchema = z
  .object({
    category: z.enum([
      'in_progress',
      'needs_input',
      'completed',
      'blocked',
      'failed',
    ]),
    summary: z.string(),
    confidence: z.number().min(0).max(1),
    question: z.string().nullable(),
    evidence: z
      .object({
        assistant_message_uuids: z.array(z.string()),
        tool_use_ids: z.array(z.string()),
      })
      .strict(),
    classified_at: timestamp,
    generation: z.number().int().positive(),
    model: z.string(),
    status: z.enum(['ok', 'stale', 'unavailable']),
    error_code: z.string().optional(),
  })
  .strict()

export const jobStateSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    job_id: uuid,
    status: z.enum([
      'queued',
      'running',
      'waiting_for_input',
      'blocked',
      'completed',
      'failed',
      'cancelled',
    ]),
    generation: z.number().int().positive(),
    active_reply_id: uuid.nullable(),
    pid: z.number().int().positive().nullable(),
    started_at: timestamp,
    updated_at: timestamp,
    ended_at: timestamp.nullable(),
    exit_code: z.number().int().nullable(),
    classification: jobClassificationSchema.nullable(),
    last_error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const childRecordSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    job_id: uuid,
    session_id: uuid,
    reply_id: uuid.nullable(),
    pid: z.number().int().positive(),
    start_token: z.string().nullable(),
    argv: z.array(z.string()),
    spawned_at: timestamp,
    ended_at: timestamp.nullable().default(null),
    exit_code: z.number().int().nullable().default(null),
    signal: z.string().nullable().default(null),
  })
  .strict()

export const supervisorRecordSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    job_id: uuid,
    session_id: uuid,
    reply_id: uuid.nullable(),
    pid: z.number().int().positive(),
    start_token: z.string().nullable(),
    started_at: timestamp,
  })
  .strict()

export const replyRecordSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    reply_id: uuid,
    job_id: uuid,
    prompt: z.string(),
    prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().positive(),
    status: z.enum(['accepted', 'completed', 'failed']),
    accepted_at: timestamp,
    completed_at: timestamp.nullable(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable(),
  })
  .strict()

export const transcriptRecordSchema = z
  .object({
    version: z.literal(LOCAL_TEMPLATE_JOBS_VERSION),
    seq: z.number().int().positive(),
    timestamp,
    job_id: uuid,
    direction: z.enum(['outbound', 'inbound', 'supervisor']),
    kind: z.enum(['user', 'sdk', 'process', 'classifier', 'error']),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export type TemplateConfig = z.infer<typeof templateConfigSchema>
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>
export type JobRecord = z.infer<typeof jobRecordSchema>
export type JobClassification = z.infer<typeof jobClassificationSchema>
export type JobState = z.infer<typeof jobStateSchema>
export type ChildRecord = z.infer<typeof childRecordSchema>
export type SupervisorRecord = z.infer<typeof supervisorRecordSchema>
export type ReplyRecord = z.infer<typeof replyRecordSchema>
export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>

export class JobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'JobError'
  }
}

export function asJobError(error: unknown, fallback = 'JOB_CORRUPT'): JobError {
  if (error instanceof JobError) return error
  return new JobError(
    fallback,
    error instanceof Error ? error.message : String(error),
  )
}
