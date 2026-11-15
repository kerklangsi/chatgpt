import { StoredSession } from '../accounts/types';
import { Logger } from '../utils/logger';
import { refreshOAuthToken } from './oauthClient';
import { CHATGPT_SESSION_URL, DEFAULT_USER_AGENT, ChatGPTSessionResponse } from './sessionAuth';

export class SessionRefresher {
  /**
   * Refreshes access token for a stored session using stored OAuth refresh token or cookie.
   */
  static async refresh(currentSession: StoredSession, _proxyUrl?: string): Promise<StoredSession> {
    if (currentSession.refreshToken) {
      const tokens = await refreshOAuthToken(currentSession.refreshToken);
      const expiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 24 * 60 * 60 * 1000;

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? currentSession.refreshToken,
        sessionToken: currentSession.sessionToken,
        cookies: currentSession.cookies,
        expiresAt,
      };
    }

    const cookieHeader =
      currentSession.cookies ??
      (currentSession.sessionToken
        ? `__Secure-next-auth.session-token=${currentSession.sessionToken}`
        : undefined);

    if (!cookieHeader && !currentSession.accessToken) {
      throw new Error('Cannot refresh ChatGPT session: No session cookie or token stored.');
    }

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
      Referer: 'https://chatgpt.com/',
    };

    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }
    if (currentSession.accessToken) {
      headers['Authorization'] = `Bearer ${currentSession.accessToken}`;
    }

    Logger.info('Refreshing ChatGPT session access token…');

    const res = await fetch(CHATGPT_SESSION_URL, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(`ChatGPT session refresh failed (HTTP ${res.status}). Re-authentication is required.`);
    }

    const data = (await res.json()) as ChatGPTSessionResponse;
    if (!data.accessToken) {
      throw new Error('ChatGPT session refresh returned empty access token.');
    }

    const expiresAt = data.expires
      ? Date.parse(data.expires)
      : Date.now() + 24 * 60 * 60 * 1000;

    return {
      accessToken: data.accessToken,
      sessionToken: currentSession.sessionToken,
      cookies: currentSession.cookies,
      expiresAt,
    };
  }
}
