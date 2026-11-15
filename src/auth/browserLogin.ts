import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { AccountMetadata, StoredSession } from '../accounts/types';
import { Logger } from '../utils/logger';
import { startLoopbackServer } from './loopbackServer';
import { buildAuthUrl, exchangeCode, generatePkce } from './oauthClient';
import { decodeJwtPayload, extractSubscriptionTier, ResolvedAccountSession } from './sessionAuth';

export class BrowserLoginService {
  /**
   * Run the ChatGPT sign-in flow via local loopback server and the system default browser.
   * Matches the Antigravity OAuth experience: opens the user's already-open default
   * browser, receives the callback on localhost, and exchanges code via PKCE.
   */
  static async loginWithBrowser(
    cancellationToken: vscode.CancellationToken,
  ): Promise<ResolvedAccountSession> {
    const state = crypto.randomBytes(16).toString('base64url');
    const { verifier, challenge } = generatePkce();

    const loopback = await startLoopbackServer(state);

    const cleanup = () => {
      loopback.dispose();
    };

    cancellationToken.onCancellationRequested(() => {
      cleanup();
    });

    try {
      const authUrl = buildAuthUrl(loopback.redirectUri, state, challenge);
      Logger.info(`Opening default browser for ChatGPT sign-in`);

      const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
      if (!opened) {
        throw new Error('Could not open the default browser for ChatGPT sign-in.');
      }

      const code = await loopback.waitForCode();
      const tokens = await exchangeCode(code, verifier, loopback.redirectUri);

      const rawJwt = tokens.id_token ?? tokens.access_token;
      const jwt = decodeJwtPayload(rawJwt);
      const tier = extractSubscriptionTier(jwt);
      const email = jwt?.email ?? 'chatgpt-user@openai.com';
      const name = jwt?.name ?? email;
      const picture = jwt?.picture;
      const userId = (jwt?.sub as string) ?? `user-${Date.now().toString(36)}`;
      const expiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : Date.now() + 24 * 60 * 60 * 1000;

      const account: AccountMetadata = {
        id: userId,
        email,
        name,
        picture,
        subscriptionTier: tier,
        authMethod: 'oauth',
        addedAt: Date.now(),
        expiresAt,
        needsReauth: false,
      };

      const session: StoredSession = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt,
      };

      return { account, session };
    } finally {
      cleanup();
    }
  }
}

