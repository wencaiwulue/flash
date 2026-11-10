export type SubscriptionType = 'max' | 'pro' | 'enterprise' | 'team'

export type RateLimitTier = 'default_claude_max_5x' | 'default_claude_max_20x'

export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'

export type OAuthProfileResponse = {
  account: {
    uuid: string
    email: string
    display_name: string | null
    created_at?: string
    has_claude_max?: boolean
    has_claude_pro?: boolean
  }
  organization: {
    uuid: string
    organization_type?:
      | 'claude_max'
      | 'claude_pro'
      | 'claude_enterprise'
      | 'claude_team'
    rate_limit_tier?: RateLimitTier | null
    has_extra_usage_enabled?: boolean | null
    billing_type?: BillingType | null
    subscription_created_at?: string | null
  }
}

export type OAuthTokenExchangeResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid?: string
  }
}

export type UserRolesResponse = {
  organization_role: string | null
  workspace_role: string | null
  organization_name: string | null
}

export type ReferralCampaign = string

export type ReferrerRewardInfo = {
  amount_minor_units: number
  currency: string
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  referral_code_details?: {
    referral_link?: string
    campaign?: string
  }
  referrer_reward?: ReferrerRewardInfo | null
  remaining_passes?: number | null
}

export type ReferralRedemptionsResponse = {
  redemptions?: unknown[]
  limit?: number
}
