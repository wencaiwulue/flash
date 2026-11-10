/**
 * Environment variable type declarations for the Claude Code project.
 *
 * This file augments the global NodeJS/Bun process.env types with the
 * environment variables used throughout Claude Code.
 */

declare namespace NodeJS {
  interface ProcessEnv {
    /** Anthropic API key for authentication */
    ANTHROPIC_API_KEY?: string
    /** Anthropic API base URL override */
    ANTHROPIC_BASE_URL?: string
    /** Bedrock/AWS authentication */
    AWS_ACCESS_KEY_ID?: string
    AWS_SECRET_ACCESS_KEY?: string
    AWS_REGION?: string
    /** GCP Vertex AI authentication */
    GOOGLE_APPLICATION_CREDENTIALS?: string
    /** OAuth configuration */
    CLAUDE_CODE_OAUTH_CLIENT_ID?: string
    CLAUDE_CODE_OAUTH_DOMAIN?: string
    /** Proxy configuration */
    HTTP_PROXY?: string
    HTTPS_PROXY?: string
    NO_PROXY?: string
    /** Debug and development flags */
    DEBUG?: string
    CLAUDE_CODE_DEBUG?: string
    /** Feature flags */
    CLAUDE_CODE_DISABLE_ANALYTICS?: string
    CLAUDE_CODE_DISABLE_TELEMETRY?: string
    CLAUDE_CODE_SKIP_AUTO_UPDATE?: string
    /** GrowthBook analytics */
    GROWTHBOOK_API_KEY?: string
    GROWTHBOOK_CLIENT_KEY?: string
    /** Log level */
    LOG_LEVEL?: string
    /** Build variant */
    USER_TYPE?: 'ant' | 'external'
    /** Node environment */
    NODE_ENV?: 'development' | 'production' | 'test'
    /** Terminal settings */
    TERM?: string
    TERM_PROGRAM?: string
    NO_COLOR?: string
    FORCE_COLOR?: string
    /** CI detection */
    CI?: string
    /** Home directory */
    HOME?: string
    /** Custom config paths */
    CLAUDE_CODE_CONFIG_PATH?: string
    /** Session management */
    CLAUDE_CODE_SESSION_ID?: string
    /** API timeout */
    CLAUDE_CODE_API_TIMEOUT?: string
  }
}

// Augment Bun's env type if available
interface BunEnv {
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  NODE_ENV?: string
  DEBUG?: string
  HOME?: string
}
