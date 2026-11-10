import type { CronTask } from './cronTasks.js'
import { cronToHuman } from './cron.js'

/**
 * Format missed one-shot tasks into a prompt that asks the model to confirm
 * with the user before executing anything.
 */
export function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while Claude was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from .claude/scheduled_tasks.json.\n\n` +
    `Do NOT execute ${plural ? 'these prompts' : 'this prompt'} yet. ` +
    `First use the AskUserQuestion tool to ask whether to run ${plural ? 'each one' : 'it'} now. ` +
    `Only execute if the user confirms.`

  const blocks = missed.map(task => {
    const meta = `[${cronToHuman(task.cron)}, created ${new Date(task.createdAt).toLocaleString()}]`
    // Use a fence one longer than any backtick run in the prompt so the task
    // cannot close the fence early and turn its contents into instructions.
    const longestRun = (task.prompt.match(/`+/g) ?? []).reduce(
      (max, run) => Math.max(max, run.length),
      0,
    )
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return `${meta}\n${fence}\n${task.prompt}\n${fence}`
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
