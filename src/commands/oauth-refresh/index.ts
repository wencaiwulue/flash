import type { Command } from '../../commands.js'

const oauthRefresh = {
  type: 'local',
  name: 'oauth-refresh',
  description: 'Refresh Claude.ai OAuth credentials or show their expiry and scopes',
  argumentHint: '[--status]',
  availability: ['claude-ai'],
  supportsNonInteractive: true,
  load: () => import('./oauthRefresh.js'),
} satisfies Command

export default oauthRefresh
