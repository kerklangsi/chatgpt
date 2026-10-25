import { AccountMetadata, StoredSession } from '../accounts/types';
import { Logger } from '../utils/logger';

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
  if (authObj && typeof authObj.plan_type === 'string') {
    return authObj.plan_type.toLowerCase();
  }
  if (typeof jwtPayload.plan_type === 'string') {
    return jwtPayload.plan_type.toLowerCase();
  }
  return 'free';
}

/**
 * Validates a token or cookie string against ChatGPT session endpoint.
 */
export async function validateAndFetchSession(
  input: string,
  _proxyUrl?: string,
): Promise<ResolvedAccountSession> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Session token or access token cannot be empty.');
  }

  let authorization: string | undefined;
  let cookieHeader: string | undefined;
  let rawSessionToken: string | undefined;

  if (trimmed.startsWith('eyJ')) {
    // Looks like a direct JWT access token
    authorization = `Bearer ${trimmed}`;
  } else if (trimmed.includes('=')) {
    // Looks like cookie string
    cookieHeader = trimmed;
    const match = trimmed.match(/__Secure-next-auth\.session-token=([^;]+)/);
    if (match) {
      rawSessionToken = match[1];
    }
  } else {
    // Treat as raw session token
    rawSessionToken = trimmed;
    cookieHeader = `__Secure-next-auth.session-token=${trimmed}`;
  }

  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    Referer: 'https://chatgpt.com/',
  };

  if (authorization) {
    headers['Authorization'] = authorization;
  }
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  Logger.debug(`Validating ChatGPT session via ${CHATGPT_SESSION_URL}`);

  const response = await fetch(CHATGPT_SESSION_URL, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `ChatGPT authentication failed (${response.status}). The session token or cookie may be invalid or expired.`,
      );
    }
    throw new Error(`Failed to validate ChatGPT session (HTTP ${response.status} ${response.statusText}).`);
  }

  const data = (await response.json()) as ChatGPTSessionResponse;
  if (!data || !data.accessToken) {
    throw new Error('ChatGPT session endpoint returned no access token. Please verify your login credentials.');
  }

  const jwt = decodeJwtPayload(data.accessToken);
  const tier = extractSubscriptionTier(jwt);
  const expiresAt = data.expires ? Date.parse(data.expires) : Date.now() + 24 * 60 * 60 * 1000;

  const userId = data.user?.id || (jwt?.sub as string) || `user-${Date.now().toString(36)}`;
  const email = data.user?.email || (jwt?.email as string) || 'chatgpt-user@openai.com';
  const name = data.user?.name || (jwt?.name as string) || 'ChatGPT User';
  const picture = data.user?.picture || data.user?.image || (jwt?.picture as string);

  const account: AccountMetadata = {
    id: userId,
    email,
    name,
    picture,
    subscriptionTier: tier,
    authMethod: trimmed.startsWith('eyJ') ? 'session_token' : 'browser',
    addedAt: Date.now(),
    expiresAt,
    needsReauth: false,
  };

  const session: StoredSession = {
    accessToken: data.accessToken,
    sessionToken: rawSessionToken,
    cookies: cookieHeader,
    expiresAt,
  };

  return { account, session };
}
