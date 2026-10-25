import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { BrowserLoginService } from '../auth/browserLogin';
import { validateAndFetchSession } from '../auth/sessionAuth';
import { SessionRefresher } from '../auth/sessionRefresher';
import { AccountStore } from './accountStore';
import { fetchQuota, QuotaUnauthorizedError } from './quotaService';
import { QuotaHistory } from './quotaHistory';
import { AccessToken, AccountMetadata, StoredSession } from './types';
import { mapWithConcurrency } from '../utils/concurrency';

const EXPIRY_SKEW_MS = 60_000;
const QUOTA_REFRESH_CONCURRENCY = 3;

export class AccountManager implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChooseActiveEmitter = new vscode.EventEmitter<string>();
  readonly onDidChooseActive = this.onDidChooseActiveEmitter.event;

  private readonly accessTokens = new Map<string, AccessToken>();
  private readonly inFlightRefresh = new Map<string, Promise<string>>();
  private autoRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly history: QuotaHistory,
  ) {}

  list(): AccountMetadata[] {
    return this.store.list();
  }

  get(accountId: string): AccountMetadata | undefined {
    return this.store.get(accountId);
  }

  get windowKey(): string {
    return this.store.windowKey;
  }

  getActive(window?: string): AccountMetadata | undefined {
    const activeId = this.store.getActiveId(window);
    if (activeId) {
      return this.store.get(activeId);
    }
    return this.list().find((account) => !account.needsReauth) ?? this.list()[0];
  }

  async reorder(orderedIds: string[]): Promise<void> {
    await this.store.reorder(orderedIds);
    this.onDidChangeEmitter.fire();
  }

  async setActive(accountId: string, byUser = true, window?: string): Promise<void> {
    await this.store.setActiveId(accountId, byUser, window);
    if (window !== undefined && window !== this.store.windowKey) {
      return;
    }
    this.onDidChangeEmitter.fire();
    if (byUser) {
      this.onDidChooseActiveEmitter.fire(accountId);
    }
  }

  chosenAt(window?: string): number | undefined {
    return this.store.chosenAt(window);
  }

  // ── Sign-in ────────────────────────────────────────────────────────────────

  /**
   * Run the browser login flow using system Edge/Chrome.
   */
  async addAccount(): Promise<AccountMetadata | undefined> {
    try {
      const configuredBrowser = vscode.workspace
        .getConfiguration('chatgptMaestro')
        .get<string>('browser.path');

      const resolved = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Waiting for ChatGPT login in your browser…',
          cancellable: true,
        },
        async (_progress, token) => {
          return await BrowserLoginService.loginWithBrowser(token, configuredBrowser);
        },
      );

      const existing = this.store.get(resolved.account.id);
      const account: AccountMetadata = {
        ...resolved.account,
        addedAt: existing?.addedAt ?? Date.now(),
        quota: existing?.quota,
      };

      await this.store.setSession(account.id, resolved.session);
      await this.store.upsert(account);
      this.cacheAccessToken(account.id, resolved.session.accessToken, resolved.session.expiresAt);

      if (!this.store.getActiveId()) {
        await this.store.setActiveId(account.id);
      }
      this.onDidChangeEmitter.fire();

      void this.refreshQuota(account.id);
      vscode.window.showInformationMessage(`Successfully connected ChatGPT account: ${account.email} (${account.subscriptionTier?.toUpperCase()})`);
      return account;
    } catch (error: any) {
      if (/cancel/i.test(error.message)) {
        Logger.info('Browser login cancelled by user.');
        return undefined;
      }
      Logger.error('Browser login failed', error);
      const choice = await vscode.window.showErrorMessage(
        `Browser login failed: ${error.message}. Would you like to enter your session token or cookie manually?`,
        'Enter Token / Cookie',
        'Dismiss',
      );
      if (choice === 'Enter Token / Cookie') {
        return await this.addAccountWithToken();
      }
      return undefined;
    }
  }

  /**
   * Manual token or cookie login flow.
   */
  async addAccountWithToken(): Promise<AccountMetadata | undefined> {
    const input = await vscode.window.showInputBox({
      title: 'ChatGPT Maestro: Paste Session Token or Cookie',
      prompt: 'Paste your ChatGPT accessToken (eyJ...), __Secure-next-auth.session-token, or full Cookie header from chatgpt.com',
      password: true,
      ignoreFocusOut: true,
    });

    if (!input || !input.trim()) {
      return undefined;
    }

    try {
      const resolved = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Validating ChatGPT session…',
        },
        async () => {
          return await validateAndFetchSession(input.trim());
        },
      );

      const existing = this.store.get(resolved.account.id);
      const account: AccountMetadata = {
        ...resolved.account,
        addedAt: existing?.addedAt ?? Date.now(),
        quota: existing?.quota,
      };

      await this.store.setSession(account.id, resolved.session);
      await this.store.upsert(account);
      this.cacheAccessToken(account.id, resolved.session.accessToken, resolved.session.expiresAt);

      if (!this.store.getActiveId()) {
        await this.store.setActiveId(account.id);
      }
      this.onDidChangeEmitter.fire();

      void this.refreshQuota(account.id);
      vscode.window.showInformationMessage(`Successfully connected ChatGPT account: ${account.email} (${account.subscriptionTier?.toUpperCase()})`);
      return account;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to add ChatGPT account: ${err.message}`);
      return undefined;
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    this.accessTokens.delete(accountId);
    this.inFlightRefresh.delete(accountId);
    await this.store.remove(accountId);
    await this.history.forget(accountId);
    this.onDidChangeEmitter.fire();
  }

  // ── Session & Tokens ───────────────────────────────────────────────────────

  async getSession(accountId: string): Promise<StoredSession | undefined> {
    return await this.store.getSession(accountId);
  }

  async getAccessToken(accountId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.accessTokens.get(accountId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }

    const pending = this.inFlightRefresh.get(accountId);
    if (pending) {
      return pending;
    }

    const refresh = this.performRefresh(accountId, signal).finally(() => {
      this.inFlightRefresh.delete(accountId);
    });
    this.inFlightRefresh.set(accountId, refresh);
    return refresh;
  }

  private async performRefresh(accountId: string, _signal?: AbortSignal): Promise<string> {
    const account = this.store.get(accountId);
    if (!account) {
      throw new Error(`Unknown account: ${accountId}`);
    }

    const storedSession = await this.store.getSession(accountId);
    if (!storedSession) {
      await this.markNeedsReauth(accountId, 'No stored session');
      throw new Error(`${account.email} needs to log in again.`);
    }

    try {
      const refreshed = await SessionRefresher.refresh(storedSession);
      await this.store.setSession(accountId, refreshed);

      if (account.needsReauth || account.lastError) {
        await this.store.patch(accountId, { needsReauth: false, lastError: undefined });
        this.onDidChangeEmitter.fire();
      }

      this.cacheAccessToken(accountId, refreshed.accessToken, refreshed.expiresAt);
      return refreshed.accessToken;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markNeedsReauth(accountId, message);
      throw new Error(`${account.email}: session expired (${message})`);
    }
  }

  private cacheAccessToken(accountId: string, token: string, expiresAt: number): void {
    this.accessTokens.set(accountId, {
      token,
      expiresAt,
    });
  }

  private async markNeedsReauth(accountId: string, reason: string): Promise<void> {
    this.accessTokens.delete(accountId);
    await this.store.patch(accountId, { needsReauth: true, lastError: reason });
    this.onDidChangeEmitter.fire();
  }

  // ── Quota ──────────────────────────────────────────────────────────────────

  async refreshQuota(accountId: string): Promise<void> {
    const account = this.store.get(accountId);
    if (!account) return;

    try {
      const accessToken = await this.getAccessToken(accountId);
      const session = await this.getSession(accountId);
      const snapshot = await fetchQuota(accessToken, session?.cookies);

      await this.store.patch(accountId, {
        quota: snapshot,
        subscriptionTier: snapshot.subscriptionTier ?? account.subscriptionTier,
        lastError: undefined,
      });
      await this.history.recordQuota(accountId, snapshot);
      this.onDidChangeEmitter.fire();
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.warn(`Quota refresh failed for ${account.email}: ${message}`);

      if (error instanceof QuotaUnauthorizedError) {
        await this.markNeedsReauth(accountId, message);
        return;
      }
      await this.store.patch(accountId, { lastError: message });
      this.onDidChangeEmitter.fire();
    }
  }

  async refreshAllQuotas(): Promise<void> {
    const accounts = this.list().filter((a) => !a.needsReauth);
    await mapWithConcurrency(accounts, QUOTA_REFRESH_CONCURRENCY, async (account) => {
      try {
        await this.refreshQuota(account.id);
      } catch {}
    });
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const intervalMinutes = vscode.workspace
      .getConfiguration('chatgptMaestro')
      .get<number>('quota.autoRefreshMinutes', 10);
    if (intervalMinutes > 0) {
      this.autoRefreshTimer = setInterval(() => {
        void this.refreshAllQuotas();
      }, intervalMinutes * 60 * 1000);
    }
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.onDidChangeEmitter.dispose();
    this.onDidChooseActiveEmitter.dispose();
  }
}
