import { AccountMetadata, StoredSession } from '../accounts/types';

export const CHATGPT_BASE_URL = 'https://chatgpt.com';
export const CHATGPT_SESSION_URL = `${CHATGPT_BASE_URL}/api/auth/session`;

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export interface ChatGPTSessionResponse {
  user?: {
    id?: string;
    name?: string;
    email?: string;
    image?: string;
    picture?: string;
  };
  expires?: string;
  accessToken?: string;
  authProvider?: string;
  error?: string;
}

export interface ResolvedAccountSession {
  account: AccountMetadata;
  session: StoredSession;
}

/**
 * Decode JWT payload safely without external dependencies.
 */
export function decodeJwtPayload(token: string): Record<string, any> | undefined {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Extract subscription tier (free, plus, team, pro) from ChatGPT JWT.
 */
export function extractSubscriptionTier(jwtPayload?: Record<string, any>): string {
  if (!jwtPayload) return 'free';
  const authObj = jwtPayload['https://api.openai.com/auth'];
  if (authObj && typeof authObj.chatgpt_plan_type === 'string') {
    return authObj.chatgpt_plan_type.toLowerCase();
  }
  if (authObj && typeof authObj.plan_type === 'string') {
    return authObj.plan_type.toLowerCase();
  }
  if (typeof jwtPayload.plan_type === 'string') {
    return jwtPayload.plan_type.toLowerCase();
  }
  return 'free';
}

