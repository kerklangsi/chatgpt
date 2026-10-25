import { CatalogModel, ModelCatalog } from '../upstream/modelCatalog';
import { AuthError, RateLimitError } from '../upstream/chatgptClient';
import { Config } from '../utils/config';
import { Logger } from '../utils/logger';
import { AccountManager } from './accountManager';
import { QuotaHistory } from './quotaHistory';
import { AccountMetadata } from './types';

export interface LeaseContext {
  accountId: string;
  email: string;
  accessToken: string;
  cookies?: string;
  model: CatalogModel;
}

export class NoAccountAvailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'NoAccountAvailableError';
  }
}

interface Cooldown {
  until: number;
  reason: string;
  strikes: number;
}

const BASE_COOLDOWN_MS = 30_000;
const STRIKE_MEMORY_MS = 10 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 500;

interface SessionBinding {
  accountId: string;
  since: number;
  lastUsed: number;
}

export class AccountLease {
  private readonly cooldowns = new Map<string, Cooldown>();
  private readonly sessions = new Map<string, SessionBinding>();
  private roundRobinIndex = 0;

  constructor(
    private readonly accounts: AccountManager,
    private readonly catalog: ModelCatalog,
    private readonly history: QuotaHistory,
  ) {
    accounts.onDidChooseActive?.(() => this.sessions.clear());
  }

  async run<T>(
    requestedModel: string,
    execute: (context: LeaseContext) => Promise<T>,
    signal?: AbortSignal,
    session?: string,
    window?: string,
  ): Promise<T> {
    let lastError: unknown;
    let waited = false;

    for (;;) {
      const candidates = this.preferSession(
        this.orderCandidates(requestedModel, window),
        requestedModel,
        session,
        window,
      );

      if (candidates.length > 0) {
        const outcome = await this.tryCandidates(requestedModel, candidates, execute, session, window);
        if (outcome.served) {
          return outcome.result as T;
        }
        lastError = outcome.error ?? lastError;
      }

      if (!waited && (await this.waitForRecovery(requestedModel, signal))) {
        waited = true;
        continue;
      }
      break;
    }

    const retryAfter = this.shortestCooldown(requestedModel);
    if (retryAfter !== undefined || lastError === undefined) {
      throw new NoAccountAvailableError(this.explainNoCandidates(requestedModel, window), retryAfter);
    }
    throw lastError;
  }

  private async tryCandidates<T>(
    requestedModel: string,
    candidates: AccountMetadata[],
    execute: (context: LeaseContext) => Promise<T>,
    session?: string,
    window?: string,
  ): Promise<{ served: boolean; result?: T; error?: unknown }> {
    let lastError: unknown;
    const bound = session ? this.sessions.get(session)?.accountId : undefined;

    for (const account of candidates) {
      const model = this.modelFor(account, requestedModel);
      if (!model) continue;

      if (this.cooldownSeconds(account.id, model.id) > 0) {
        continue;
      }

      try {
        const accessToken = await this.accounts.getAccessToken(account.id, undefined);
        const stored = await this.accounts.getSession(account.id);

        const result = await execute({
          accountId: account.id,
          email: account.email,
          accessToken,
          cookies: stored?.cookies,
          model,
        });

        this.clearCooldown(account.id, model.id);
        if (account.id !== bound) {
          await this.promoteIfRotated(account, window);
        }
        this.bindSession(session, account.id);
        return { served: true, result };
      } catch (error: any) {
        lastError = error;

        if (error instanceof RateLimitError) {
          this.markCooldown(account.id, model.id, error.retryAfterSeconds, error.message);
          Logger.warn(`${account.email} is rate limited on ${model.id}; rotating to another account…`);
          continue;
        }

        if (error instanceof AuthError) {
          Logger.warn(`${account.email} authentication expired; trying another account…`);
          continue;
        }

        throw error;
      }
    }

    return { served: false, error: lastError };
  }

  async recordUsage(
    context: LeaseContext,
    inputTokens: number,
    outputTokens: number,
    thoughtTokens?: number,
  ): Promise<void> {
    await this.history.recordUsage({
      at: Date.now(),
      accountId: context.accountId,
      modelId: context.model.id,
      inputTokens,
      outputTokens,
      thoughtTokens,
    });
  }

  markCooldown(
    accountId: string,
    modelId: string,
    retryAfterSeconds: number | undefined,
    reason: string,
  ): void {
    const key = `${accountId}::${modelId}`;
    const existing = this.cooldowns.get(key);
    const now = Date.now();
    const capMs = Math.max(BASE_COOLDOWN_MS, Config.rotationCooldownMinutes() * 60_000);

    const strikes =
      existing === undefined || now - existing.until > STRIKE_MEMORY_MS
        ? 1
        : existing.until > now
          ? existing.strikes
          : existing.strikes + 1;

    const durationMs = retryAfterSeconds
      ? retryAfterSeconds * 1000
      : Math.min(BASE_COOLDOWN_MS * 2 ** (strikes - 1), capMs);
    const until = Math.max(now + durationMs, existing?.until ?? 0);
    this.cooldowns.set(key, { until, reason, strikes });
  }

  cooldownSeconds(accountId: string, modelId: string): number {
    const key = `${accountId}::${modelId}`;
    const cooldown = this.cooldowns.get(key);
    if (!cooldown) return 0;
    const remainingMs = cooldown.until - Date.now();
    if (remainingMs <= 0) {
      if (-remainingMs > STRIKE_MEMORY_MS) {
        this.cooldowns.delete(key);
      }
      return 0;
    }
    return Math.ceil(remainingMs / 1000);
  }

  private clearCooldown(accountId: string, modelId: string): void {
    this.cooldowns.delete(`${accountId}::${modelId}`);
  }

  private async waitForRecovery(requestedModel: string, signal?: AbortSignal): Promise<boolean> {
    const budgetSeconds = Config.rotationMaxWaitSeconds();
    const wait = this.shortestCooldown(requestedModel);
    if (budgetSeconds <= 0 || wait === undefined || wait > budgetSeconds || signal?.aborted) {
      return false;
    }

    const delayMs = wait * 1000 + Math.floor(Math.random() * 1000);
    Logger.info(`All ChatGPT accounts cooling down for '${requestedModel}'; waiting ${wait}s`);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, delayMs);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      }
      signal?.addEventListener('abort', finish, { once: true });
    });

    return !signal?.aborted;
  }

  private shortestCooldown(requestedModel: string): number | undefined {
    const waits = this.accounts
      .list()
      .filter((a) => !a.needsReauth)
      .map((a) => {
        const m = this.modelFor(a, requestedModel);
        return m ? this.cooldownSeconds(a.id, m.id) : 0;
      })
      .filter((s) => s > 0);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  }

  private orderCandidates(requestedModel: string, window?: string): AccountMetadata[] {
    const active = this.accounts.getActive(window);
    const strategy = Config.rotationStrategy();

    if (strategy === 'manual') {
      return active && this.isUsable(active, requestedModel) ? [active] : [];
    }

    const usable = this.accounts
      .list()
      .filter((account) => this.isUsable(account, requestedModel));

    if (usable.length === 0) return [];

    const fallbacks = usable.filter((account) => account.id !== active?.id);
    const ordered =
      strategy === 'highest-quota-first'
        ? [...fallbacks].sort((a, b) => this.quotaOf(b, requestedModel) - this.quotaOf(a, requestedModel))
        : this.rotate(fallbacks);

    const activeIsUsable = active !== undefined && usable.some((a) => a.id === active.id);
    return activeIsUsable ? [active!, ...ordered] : ordered;
  }

  private preferSession(
    candidates: AccountMetadata[],
    _requestedModel: string,
    session: string | undefined,
    window?: string,
  ): AccountMetadata[] {
    const binding = session ? this.sessions.get(session) : undefined;
    if (!binding) return candidates;

    const chosenAt = this.accounts.chosenAt?.(window) ?? 0;
    if (Date.now() - binding.lastUsed > SESSION_TTL_MS || chosenAt > binding.since) {
      this.sessions.delete(session!);
      return candidates;
    }

    const bound = candidates.find((account) => account.id === binding.accountId);
    if (!bound) return candidates;
    return [bound, ...candidates.filter((a) => a !== bound)];
  }

  private bindSession(session: string | undefined, accountId: string): void {
    if (!session) return;
    const previous = this.sessions.get(session);
    const now = Date.now();
    this.sessions.set(session, {
      accountId,
      since: previous?.accountId === accountId ? previous.since : now,
      lastUsed: now,
    });
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
  }

  private modelFor(_account: AccountMetadata, requestedModel: string): CatalogModel | undefined {
    return this.catalog.match(requestedModel).model;
  }

  private isUsable(account: AccountMetadata, requestedModel: string): boolean {
    if (account.needsReauth) return false;
    const model = this.modelFor(account, requestedModel);
    return model ? this.cooldownSeconds(account.id, model.id) === 0 : false;
  }

  private rotate(accounts: AccountMetadata[]): AccountMetadata[] {
    if (accounts.length <= 1) return accounts;
    const offset = this.roundRobinIndex % accounts.length;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % accounts.length;
    return [...accounts.slice(offset), ...accounts.slice(0, offset)];
  }

  private quotaOf(account: AccountMetadata, requestedModel: string): number {
    const model = this.modelFor(account, requestedModel);
    return model?.quotaPercent ?? 0;
  }

  private async promoteIfRotated(account: AccountMetadata, window?: string): Promise<void> {
    if (Config.rotationStrategy() === 'manual') return;
    const active = this.accounts.getActive(window);
    if (active?.id !== account.id) {
      Logger.info(`Switched active ChatGPT account to ${account.email}`);
      await this.accounts.setActive(account.id, false, window);
    }
  }

  private explainNoCandidates(requestedModel: string, _window?: string): string {
    const all = this.accounts.list();
    if (all.length === 0) {
      return 'No ChatGPT account has been added yet. Please use "ChatGPT Maestro: Add Account (Browser Login)".';
    }
    if (all.every((a) => a.needsReauth)) {
      return 'Every ChatGPT account needs to sign in again.';
    }
    const wait = this.shortestCooldown(requestedModel);
    if (wait !== undefined) {
      return `Every ChatGPT account is currently rate limited on '${requestedModel}'. Please try again in ${wait}s.`;
    }
    return `No ChatGPT account is currently available for '${requestedModel}'.`;
  }
}
