import { lstat } from 'fs/promises'
import { basename, resolve } from 'path'
import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { uploadBriefAttachment } from '../BriefTool/upload.js'
import { SEND_USER_FILE_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  file_path: z.string().describe('Path to the file to send to the user'),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  message: z.string(),
})
type Output = z.infer<typeof outputSchema>

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 2_000,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    return 'Upload a local file so the remote user can preview it'
  },
  async prompt() {
    return 'Send a local file to the user through the active Remote Control bridge. Files are uploaded to the configured OAuth file service and must be 30 MB or smaller. Do not claim delivery unless a file ID is returned.'
  },
  async checkPermissions(input, context) {
    const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
    return FileReadTool.checkPermissions(input, context)
  },
  renderToolUseMessage() {
    return null
  },
  async call({ file_path }, context) {
    if (!isReplBridgeActive()) {
      throw new Error('Sending files requires an active Remote Control bridge')
    }
    const fullPath = resolve(getCwd(), file_path)
    const metadata = await lstat(fullPath)
    if (!metadata.isFile()) throw new Error(`Not a regular file: ${fullPath}`)
    const fileId = await uploadBriefAttachment(fullPath, metadata.size, {
      replBridgeEnabled: true,
      signal: context.abortController.signal,
    })
    if (!fileId) throw new Error(`File upload failed: ${file_path}`)
    return {
      data: {
        fileId,
        fileName: basename(fullPath),
        message: `Uploaded ${basename(fullPath)} for the user.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
