/** Remaining quota for one upstream model, as reported by fetchAvailableModels. */
export interface ModelQuota {
  modelId: string;
  displayName?: string;
  /** Remaining quota, 0–100. */
  percentage: number;
  /** ISO timestamp when the quota window resets, or '' when unknown. */
  resetTime: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  recommended?: boolean;
  /**
  * Position in ChatGPT's model list, or undefined when the model is
  * reported by quota data but is not in the configured catalog.
   */
  agentOrder?: number;
}

/** One rolling window (e.g. 5-hour or weekly) from retrieveUserQuotaSummary. */
export interface QuotaBucket {
  bucketId: string;
  window: string;
  remainingFraction: number;
  resetTime: string;
  displayName?: string;
  description?: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
}

export interface QuotaSnapshot {
  fetchedAt: number;
  models: Record<string, ModelQuota>;
  groups?: QuotaGroup[];
  subscriptionTier?: 'free' | 'plus' | 'team' | 'pro' | string;
  isForbidden?: boolean;
}

/** Everything about an account except its tokens, which live in SecretStorage. */
export interface AccountMetadata {
  /** Stable ChatGPT account ID (e.g. user-xxx). */
  id: string;
  email: string;
  name?: string;
  picture?: string;
  subscriptionTier?: 'free' | 'plus' | 'team' | 'pro' | string;
  authMethod: 'browser' | 'session_token' | 'oauth';
  addedAt: number;
  expiresAt?: number;
  needsReauth?: boolean;
  lastError?: string;
  quota?: QuotaSnapshot;
}

/** Stored secret session credentials in SecretStorage. */
export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  sessionToken?: string;
  cookies?: string;
  expiresAt: number;
}

/** A model the upstream answered with its "no longer available" notice. */
export interface RetiredModel {
  name: string;
  successor?: string;
  at: number;
}

/** A cached access token with its expiry. */
export interface AccessToken {
  token: string;
  expiresAt: number;
}

/**
 * Token spend reported by one upstream request. It is what gets recorded, not
 * what gets stored: each one is added into its hour's {@link UsageBucket}.
 */
export interface UsageSample {
  at: number;
  accountId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
}

/**
 * Token spend summed over one clock hour, for one account and model. Hours
 * rather than requests: a busy day is thousands of requests, and keeping each
 * one either grows globalState without bound or, capped, quietly drops the
 * oldest days that a month view would then under-report.
 */
export interface UsageBucket {
  /** Start of the UTC hour, epoch ms. */
  at: number;
  accountId: string;
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

/** A quota reading kept for the history chart. */
export interface QuotaSample {
  at: number;
  accountId: string;
  modelId: string;
  percentage: number;
}
