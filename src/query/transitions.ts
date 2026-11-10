export type Continue =
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }

export type Terminal =
  | {
      reason:
        | 'completed'
        | 'blocking_limit'
        | 'image_error'
        | 'prompt_too_long'
        | 'aborted_streaming'
        | 'aborted_tools'
        | 'stop_hook_prevented'
        | 'hook_stopped'
    }
  | { reason: 'model_error'; error: unknown }
  | { reason: 'max_turns'; turnCount: number }
