import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_OAUTH_SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  });
  return `${OPENAI_AUTH_URL}?${params.toString()}`;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  Logger.info('Exchanging ChatGPT authorization code for tokens…');
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errText || res.statusText}`);
  }

  return (await res.json()) as OAuthTokens;
}

export async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  Logger.info('Refreshing ChatGPT access token via OpenAI OAuth…');
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${errText || res.statusText}`);
  }

  return (await res.json()) as OAuthTokens;
}
