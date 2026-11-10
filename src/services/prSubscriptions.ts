import { execa } from 'execa'
import { logForDebugging } from '../utils/debug.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'

export type PREvent = { id: string; summary: string }
export type PRSubscriptionKey = `${string}#${number}`

type Subscription = {
  timer: ReturnType<typeof setInterval>
  seen: Set<string>
  initialized: boolean
}

async function fetchGithubEvents(endpoint: string): Promise<unknown> {
  const result = await execa('gh', ['api', endpoint], { timeout: 15_000 })
  return JSON.parse(result.stdout)
}

function eventId(value: unknown, prefix: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'number' || typeof id === 'string' ? `${prefix}:${id}` : undefined
}

export class PRSubscriptionManager {
  private readonly subscriptions = new Map<PRSubscriptionKey, Subscription>()

  constructor(
    private readonly fetchJson: (endpoint: string) => Promise<unknown> = fetchGithubEvents,
    private readonly intervalMs = 30_000,
  ) {}

  list(): PRSubscriptionKey[] {
    return [...this.subscriptions.keys()].sort()
  }

  async subscribe(repository: string, prNumber: number): Promise<boolean> {
    const key = `${repository}#${prNumber}` as PRSubscriptionKey
    if (this.subscriptions.has(key)) return false
    const subscription: Subscription = {
      seen: new Set(),
      initialized: false,
      timer: setInterval(() => {
        void this.poll(key).catch(error => {
          logForDebugging(`PR poll failed for ${key}: ${String(error)}`)
        })
      }, this.intervalMs),
    }
    subscription.timer.unref()
    this.subscriptions.set(key, subscription)
    await this.poll(key)
    return true
  }

  unsubscribe(key: PRSubscriptionKey): boolean {
    const subscription = this.subscriptions.get(key)
    if (!subscription) return false
    clearInterval(subscription.timer)
    this.subscriptions.delete(key)
    return true
  }

  stopAll(): void {
    for (const key of this.list()) this.unsubscribe(key)
  }

  async poll(key: PRSubscriptionKey): Promise<PREvent[]> {
    const subscription = this.subscriptions.get(key)
    if (!subscription) return []
    const [repository, number] = key.split('#')
    const pull = await this.fetchJson(`/repos/${repository}/pulls/${number}`)
    const headSha = (pull as { head?: { sha?: string } }).head?.sha
    if (!headSha) throw new Error(`Unable to resolve PR head SHA for ${key}`)
    const [comments, reviews, checks] = await Promise.all([
      this.fetchJson(`/repos/${repository}/issues/${number}/comments?per_page=100`),
      this.fetchJson(`/repos/${repository}/pulls/${number}/reviews?per_page=100`),
      this.fetchJson(`/repos/${repository}/commits/${headSha}/check-runs`),
    ])
    const events: PREvent[] = []
    for (const comment of Array.isArray(comments) ? comments : []) {
      const id = eventId(comment, 'comment')
      const body = (comment as { body?: string }).body
      if (id) events.push({ id, summary: `PR ${key} comment: ${body ?? ''}` })
    }
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const id = eventId(review, 'review')
      const state = (review as { state?: string }).state
      if (id) events.push({ id, summary: `PR ${key} review: ${state ?? 'updated'}` })
    }
    const checkRuns = (checks as { check_runs?: unknown[] }).check_runs ?? []
    for (const run of checkRuns) {
      const id = eventId(run, 'check')
      const value = run as { name?: string; status?: string; conclusion?: string }
      if (id) {
        events.push({
          id,
          summary: `PR ${key} check ${value.name ?? ''}: ${value.status ?? ''}/${value.conclusion ?? ''}`,
        })
      }
    }

    const fresh = subscription.initialized
      ? events.filter(event => !subscription.seen.has(event.id))
      : []
    for (const event of events) subscription.seen.add(event.id)
    subscription.initialized = true
    for (const event of fresh) {
      enqueuePendingNotification({
        value: event.summary,
        mode: 'task-notification',
        priority: 'later',
      })
    }
    return fresh
  }
}
