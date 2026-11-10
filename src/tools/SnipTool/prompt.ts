export const SNIP_TOOL_NAME = 'Snip'
export const SNIP_TOOL_PROMPT = `Remove selected older messages from the active model context while keeping recent work intact.

Use the short [id:...] values attached to user messages. Snip only turns that are no longer needed. Tool_use/tool_result pairs are handled together, and the latest messages are protected. The change applies at the next context-processing step; it does not delete the on-disk transcript.`
