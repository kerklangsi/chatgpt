import { Logger } from '../utils/logger';
import { ModelQuota, QuotaGroup, QuotaSnapshot } from './types';
import { CHATGPT_SESSION_URL, DEFAULT_USER_AGENT, ChatGPTSessionResponse, decodeJwtPayload, extractSubscriptionTier } from '../auth/sessionAuth';

export class QuotaForbiddenError extends Error {
  constructor(message = 'Access forbidden to ChatGPT session.') {
    super(message);
    this.name = 'QuotaForbiddenError';
  }
}

export class QuotaUnauthorizedError extends Error {
  constructor(message = 'ChatGPT session token expired or unauthorized.') {
    super(message);
    this.name = 'QuotaUnauthorizedError';
  }
}

export async function fetchQuota(
  accessToken: string,
  cookies?: string,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Referer: 'https://chatgpt.com/',
  };

  if (cookies) {
    headers['Cookie'] = cookies;
  }

  let tier = 'plus';
  if (cookies) {
    try {
      const res = await fetch(CHATGPT_SESSION_URL, {
        method: 'GET',
        headers,
        signal,
      });

      if (res.status === 401) {
        throw new QuotaUnauthorizedError();
      }
      if (res.status === 403) {
        throw new QuotaForbiddenError();
      }

      if (res.ok) {
        const data = (await res.json()) as ChatGPTSessionResponse;
        if (data.accessToken) {
          const jwt = decodeJwtPayload(data.accessToken);
          tier = extractSubscriptionTier(jwt);
        }
      }
    } catch (err) {
      if (err instanceof QuotaUnauthorizedError || err instanceof QuotaForbiddenError) {
        throw err;
      }
      Logger.debug(`Quota probe session read: ${err}`);
    }
  } else {
    const jwt = decodeJwtPayload(accessToken);
    tier = extractSubscriptionTier(jwt);
  }

  let realQuota: {
    planType?: string;
    usedPercent?: number;
    resetTime?: string;
    windowMinutes?: number;
    secondaryUsedPercent?: number;
    secondaryResetTime?: string;
  } | undefined;

  try {
    const usageRes = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal,
    });
    if (usageRes.ok) {
      const usageData = (await usageRes.json()) as any;
      if (usageData) {
        if (usageData.plan_type) {
          tier = String(usageData.plan_type).toLowerCase();
        }
        const rateLimit = usageData.rate_limit;
        const primary = rateLimit?.primary_window;
        const secondary = rateLimit?.secondary_window;

        let primaryResetTime = '';
        if (primary) {
          if (typeof primary.reset_at === 'number' && primary.reset_at > 0) {
            const ms = primary.reset_at < 1e12 ? primary.reset_at * 1000 : primary.reset_at;
            primaryResetTime = new Date(ms).toISOString();
          } else if (typeof primary.reset_after_seconds === 'number' && primary.reset_after_seconds > 0) {
            primaryResetTime = new Date(Date.now() + primary.reset_after_seconds * 1000).toISOString();
          }
        }

        let secondaryResetTime = '';
        if (secondary) {
          if (typeof secondary.reset_at === 'number' && secondary.reset_at > 0) {
            const ms = secondary.reset_at < 1e12 ? secondary.reset_at * 1000 : secondary.reset_at;
            secondaryResetTime = new Date(ms).toISOString();
          } else if (typeof secondary.reset_after_seconds === 'number' && secondary.reset_after_seconds > 0) {
            secondaryResetTime = new Date(Date.now() + secondary.reset_after_seconds * 1000).toISOString();
          }
        }

        realQuota = {
          planType: usageData.plan_type,
          usedPercent: typeof primary?.used_percent === 'number' ? primary.used_percent : undefined,
          resetTime: primaryResetTime || undefined,
          windowMinutes:
            typeof primary?.limit_window_seconds === 'number'
              ? Math.round(primary.limit_window_seconds / 60)
              : undefined,
          secondaryUsedPercent:
            typeof secondary?.used_percent === 'number' ? secondary.used_percent : undefined,
          secondaryResetTime: secondaryResetTime || undefined,
        };
      }
    }
  } catch (err) {
    Logger.debug(`Live wham/usage fetch skipped: ${err}`);
  }

  const isPaid = tier === 'plus' || tier === 'team' || tier === 'pro';

  const defaultGptPercent = realQuota?.usedPercent !== undefined
    ? Math.max(0, Math.min(100, 100 - realQuota.usedPercent))
    : isPaid ? 100 : 70;
  const defaultResetTime = realQuota?.resetTime ?? '';

  const defaultSecondaryPercent = realQuota?.secondaryUsedPercent !== undefined
    ? Math.max(0, Math.min(100, 100 - realQuota.secondaryUsedPercent))
    : isPaid ? 100 : 40;
  const secondaryResetTime = realQuota?.secondaryResetTime ?? defaultResetTime;

  const models: Record<string, ModelQuota> = {
    'gpt-4o': {
      modelId: 'gpt-4o',
      displayName: 'GPT-4o (Omni)',
      percentage: defaultGptPercent,
      resetTime: defaultResetTime,
      supportsImages: true,
      supportsThinking: false,
      recommended: true,
      agentOrder: 1,
    },
    'o3-mini': {
      modelId: 'o3-mini',
      displayName: 'OpenAI o3-mini',
      percentage: defaultSecondaryPercent,
      resetTime: secondaryResetTime,
      supportsImages: false,
      supportsThinking: true,
      thinkingBudget: 32_768,
      recommended: true,
      agentOrder: 2,
    },
    'o1': {
      modelId: 'o1',
      displayName: 'OpenAI o1',
      percentage: isPaid ? defaultSecondaryPercent : 0,
      resetTime: isPaid ? secondaryResetTime : '',
      supportsImages: true,
      supportsThinking: true,
      thinkingBudget: 65_536,
      agentOrder: 3,
    },
    'gpt-4o-mini': {
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o Mini',
      percentage: 100,
      resetTime: '',
      supportsImages: true,
      supportsThinking: false,
      agentOrder: 4,
    },
    'o1-mini': {
      modelId: 'o1-mini',
      displayName: 'OpenAI o1-mini',
      percentage: isPaid ? defaultSecondaryPercent : Math.min(defaultSecondaryPercent, 20),
      resetTime: secondaryResetTime,
      supportsImages: false,
      supportsThinking: true,
      thinkingBudget: 16_384,
      agentOrder: 5,
    },
    'auto': {
      modelId: 'auto',
      displayName: 'ChatGPT Auto',
      percentage: defaultGptPercent,
      resetTime: defaultResetTime,
      supportsImages: true,
      supportsThinking: false,
      agentOrder: 6,
    },
  };

  const groups: QuotaGroup[] = [];
  if (realQuota?.usedPercent !== undefined) {
    groups.push({
      displayName: 'GPT models',
      description: 'Standard usage window',
      buckets: [
        {
          bucketId: 'primary',
          window: realQuota.windowMinutes ? `${realQuota.windowMinutes}m` : 'Rolling',
          remainingFraction: defaultGptPercent / 100,
          resetTime: defaultResetTime,
          displayName: 'Usage limit',
        },
      ],
    });
  }

  return {
    fetchedAt: Date.now(),
    models,
    groups: groups.length > 0 ? groups : undefined,
    subscriptionTier: tier,
    isForbidden: false,
  };
}
