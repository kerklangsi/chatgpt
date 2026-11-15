import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import {
  QuotaHistory,
  USAGE_RANGES,
  localDayStart,
  timeWindow,
} from '../accounts/quotaHistory';
import { AccountMetadata } from '../accounts/types';
import { quotaPools } from '../accounts/quotaPools';
import { displayNamesFor } from '../upstream/modelNames';
import { Logger } from '../utils/logger';

const AGENT_COMMANDS: Record<string, { apply: string; restore?: string }> = {
  'claude-code': {
    apply: 'chatgpt.claudeCode.apply',
    restore: 'chatgpt.claudeCode.restore',
  },
  codex: {
    apply: 'chatgpt.codex.apply',
    restore: 'chatgpt.codex.restore',
  },
  copilot: {
    apply: 'chatgpt.copilot.setup',
    restore: 'chatgpt.copilot.restore',
  },
  commitMessages: {
    apply: 'chatgpt.commitMessages.apply',
    restore: 'chatgpt.commitMessages.restore',
  },
};

const POST_DEBOUNCE_MS = 150;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_STRIP_DAYS = 30;
const MAX_STRIP_DAYS = 90;

export interface ExtraStatus {
  gateway?: { running: boolean; port?: number; error?: string };
  integrations?: Array<{
    target: string;
    label: string;
    installed: boolean;
    active: boolean;
    modelId?: string;
    applyLabel?: string;
    idleText?: string;
    detail?: string;
  }>;
}

export class AccountsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'chatgpt-accounts';
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private pending: NodeJS.Timeout | undefined;
  private statusProvider?: () => Promise<ExtraStatus>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accounts: AccountManager,
    private readonly history: QuotaHistory,
  ) {
    this.disposables.push(
      accounts.onDidChange(() => this.schedulePost()),
      history.onDidChange(() => this.schedulePost()),
    );
  }

  setStatusProvider(provider: () => Promise<ExtraStatus>): void {
    this.statusProvider = provider;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.configure(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  openAsPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'chatgpt.accountsPanel',
      'ChatGPT',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');
    this.configure(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private configure(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
      ],
    };
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage((message) => this.handleMessage(message));
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
          await this.postState();
          break;
        case 'applyAgent':
        case 'restoreAgent': {
          const commands = AGENT_COMMANDS[message.agent];
          const command = message.type === 'applyAgent' ? commands?.apply : commands?.restore;
          if (command) {
            await vscode.commands.executeCommand(command);
          }
          break;
        }
        case 'restartGateway':
          await vscode.commands.executeCommand('chatgpt.restartGateway');
          await this.postState();
          break;
        case 'copyGatewayInfo':
          await vscode.commands.executeCommand('chatgpt.copyGatewayInfo');
          break;
        case 'addAccount':
          await vscode.commands.executeCommand('chatgpt.addAccount');
          break;
        case 'refreshAll':
          await this.accounts.refreshAllQuotas();
          break;
        case 'refreshAccount':
          await this.accounts.refreshQuota(message.accountId);
          break;
        case 'reorderAccounts':
          await this.accounts.reorder(message.accountIds ?? []);
          break;
        case 'setActive':
          await this.accounts.setActive(message.accountId);
          break;
        case 'removeAccount':
          await vscode.commands.executeCommand('chatgpt.removeAccount', message.accountId);
          break;
        case 'reauth':
          await vscode.commands.executeCommand('chatgpt.addAccount');
          break;
        case 'clearHistory':
          await this.clearHistory();
          break;
        case 'openLogs':
          Logger.show();
          break;
        default:
          Logger.debug(`Unhandled webview message: ${JSON.stringify(message)}`);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`ChatGPT: ${error.message}`);
    }
  }

  async postState(): Promise<void> {
    const state = await this.buildState();
    this.view?.webview.postMessage({ type: 'state', state });
    this.panel?.webview.postMessage({ type: 'state', state });
  }

  private schedulePost(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.postState(), POST_DEBOUNCE_MS);
  }

  private async buildState() {
    const activeId = this.accounts.getActive()?.id;
    let status: ExtraStatus | undefined;
    try {
      status = await this.statusProvider?.();
    } catch (error) {
      Logger.warn('Could not read integration status', error);
    }

    return {
      accounts: this.accounts.list().map((account) => toAccountView(account, activeId)),
      activeId,
      usage: this.usageView(),
      history: this.history.series(),
      status,
    };
  }

  private usageView() {
    const now = this.history.now();
    const ranges: Record<string, any> = {};
    for (const range of USAGE_RANGES) {
      const window = timeWindow(range, now);
      ranges[range] = {
        from: Number.isFinite(window.from) ? window.from : null,
        rows: this.history.totals(window),
      };
    }

    const firstAt = this.history.firstUsageAt();
    const span =
      firstAt === undefined
        ? 0
        : Math.round((localDayStart(now) - localDayStart(firstAt)) / DAY_MS) + 1;
    const count = Math.min(MAX_STRIP_DAYS, Math.max(MIN_STRIP_DAYS, span));
    const days = this.history.dailyTotals(count, now).map((day) => ({
      start: day.start,
      requests: day.requests,
      tokens: day.inputTokens + day.outputTokens + day.thoughtTokens,
    }));

    return { ranges, days, firstAt: firstAt ?? null, daysTruncated: span > count };
  }

  private async clearHistory(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Clear all ChatGPT usage history?',
      { modal: true },
      'Clear history',
    );
    if (answer === 'Clear history') {
      await this.history.clear();
      this.schedulePost();
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...segments: string[]) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', ...segments))
        .toString();

    const html = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'webview', 'index.html'),
      'utf-8',
    );

    return html
      .split('{{cspSource}}')
      .join(webview.cspSource)
      .split('{{variablesCssUri}}')
      .join(uri('styles', 'variables.css'))
      .split('{{mainCssUri}}')
      .join(uri('styles', 'main.css'))
      .split('{{cardsCssUri}}')
      .join(uri('styles', 'cards.css'))
      .split('{{appJsUri}}')
      .join(uri('scripts', 'app.js'))
      .split('{{logoUri}}')
      .join(
        webview
          .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png'))
          .toString(),
      );
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.disposables.forEach((d) => d.dispose());
    this.panel?.dispose();
  }
}

function formatResetsIn(resetTime: string): string | undefined {
  if (!resetTime) {
    return undefined;
  }
  const target = Date.parse(resetTime);
  if (Number.isNaN(target)) {
    return undefined;
  }

  const remainingMinutes = Math.max(0, Math.round((target - Date.now()) / 60_000));
  if (remainingMinutes >= 24 * 60) {
    const days = Math.floor(remainingMinutes / (24 * 60));
    const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function toAccountView(account: AccountMetadata, activeId: string | undefined) {
  const quotas = Object.values(account.quota?.models ?? {});
  const names = displayNamesFor(quotas);
  const models = quotas
    .map((model) => ({
      ...model,
      displayName: names[model.modelId],
      resetsIn: formatResetsIn(model.resetTime),
    }))
    .sort((a, b) => (a.displayName ?? a.modelId).localeCompare(b.displayName ?? b.modelId));

  return {
    id: account.id,
    email: account.email,
    name: account.name,
    picture: account.picture,
    tier: account.subscriptionTier,
    isActive: account.id === activeId,
    needsReauth: account.needsReauth === true,
    lastError: account.lastError,
    quotaFetchedAt: account.quota?.fetchedAt,
    lowestQuota: models.length > 0 ? Math.min(...models.map((m) => m.percentage)) : undefined,
    models,
    pools: quotaPools(models),
    groups: (account.quota?.groups ?? []).map((group) => ({
      displayName: group.displayName,
      description: group.description,
      buckets: group.buckets.map((bucket) => ({
        displayName: bucket.displayName ?? bucket.window ?? bucket.bucketId,
        percentage: Math.floor(bucket.remainingFraction * 100),
        resetsIn: formatResetsIn(bucket.resetTime),
      })),
    })),
  };
}
