import { Logger } from '../utils/logger';
import { ModelQuota, QuotaSnapshot } from './types';
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

  const isPaid = tier === 'plus' || tier === 'team' || tier === 'pro';

  const models: Record<string, ModelQuota> = {
    'gpt-4o': {
      modelId: 'gpt-4o',
      displayName: 'GPT-4o (Omni)',
      percentage: isPaid ? 100 : 70,
      resetTime: '',
      supportsImages: true,
      supportsThinking: false,
      recommended: true,
      agentOrder: 1,
    },
    'o3-mini': {
      modelId: 'o3-mini',
      displayName: 'OpenAI o3-mini',
      percentage: isPaid ? 100 : 40,
      resetTime: '',
      supportsImages: false,
      supportsThinking: true,
      thinkingBudget: 32_768,
      recommended: true,
      agentOrder: 2,
    },
    'o1': {
      modelId: 'o1',
      displayName: 'OpenAI o1',
      percentage: isPaid ? 100 : 0,
      resetTime: '',
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
      percentage: isPaid ? 100 : 20,
      resetTime: '',
      supportsImages: false,
      supportsThinking: true,
      thinkingBudget: 16_384,
      agentOrder: 5,
    },
    'auto': {
      modelId: 'auto',
      displayName: 'ChatGPT Auto',
      percentage: 100,
      resetTime: '',
      supportsImages: true,
      supportsThinking: false,
      agentOrder: 6,
    },
  };

  return {
    fetchedAt: Date.now(),
    models,
    subscriptionTier: tier,
    isForbidden: false,
  };
}
