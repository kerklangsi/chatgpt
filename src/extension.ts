import * as vscode from 'vscode';
import { AccountLease } from './accounts/accountLease';
import { AccountManager } from './accounts/accountManager';
import { AccountStore } from './accounts/accountStore';
import { QuotaHistory } from './accounts/quotaHistory';
import { CoordinatorService } from './coordinator/coordinatorService';
import { registerCoordinatorTools } from './coordinator/coordinatorTools';
import { GatewayManager } from './gateway/manager';
import { AgentIntegration } from './integrations/agentIntegration';
import { ClaudeCodeIntegration } from './integrations/claudeCode';
import { CodexIntegration } from './integrations/codex';
import { AgentTarget } from './integrations/shared';
import { CLAUDE_HEADERS_ENV, WINDOW_ENV, withWindowHeader } from './integrations/window';
import { ChatGPTChatProvider } from './provider/copilotProvider';
import { AccountsViewProvider } from './ui/accountsView';
import { ChatGPTClient } from './upstream/chatgptClient';
import { ModelCatalog } from './upstream/modelCatalog';
import { Config } from './utils/config';
import { Logger } from './utils/logger';

const CHAT_PROVIDER_VENDOR = 'chatgpt-maestro';
const COPILOT_PUBLISH_KEY = 'chatgptMaestro.copilotPublish';
const COPILOT_UTILITY_KEY = 'chatgptMaestro.copilotUtilityDefaultSet';
const UTILITY_SETTINGS = ['chat.utilityModel', 'chat.utilitySmallModel'] as const;
const UTILITY_SMALL_SETTING = 'chat.utilitySmallModel';
const UTILITY_SMALL_KEY = 'chatgptMaestro.copilotUtilitySmallModel';

const AGENT_LABELS: Record<AgentTarget, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export function activate(context: vscode.ExtensionContext): void {
  Logger.init();
  Logger.info('ChatGPT Maestro activating…');

  const history = new QuotaHistory(context.globalState);
  const store = new AccountStore(context.globalState, context.secrets, context.workspaceState);
  void store.claimActiveId();
  const accounts = new AccountManager(store, history);

  const catalog = new ModelCatalog(accounts);
  const client = new ChatGPTClient();
  const lease = new AccountLease(accounts, catalog, history);
  const coordinator = new CoordinatorService(context);
  registerCoordinatorTools(context, coordinator);

  const gateway = new GatewayManager(context.secrets, lease, client, catalog);

  const claudeCode = new ClaudeCodeIntegration(context.globalState);
  const codex = new CodexIntegration(context.globalState);
  const integrations: AgentIntegration[] = [claudeCode, codex];

  const chatProvider = new ChatGPTChatProvider(catalog, lease, client);
  chatProvider.setPublished(context.globalState.get<boolean>(COPILOT_PUBLISH_KEY) !== false);

  const accountsView = new AccountsViewProvider(context.extensionUri, accounts, history, coordinator);

  accountsView.setStatusProvider(async () => {
    const available = catalog.listAll().length;
    const publishing = chatProvider.isPublishing;
    const copilotRow = {
      target: 'copilot',
      label: 'Copilot Chat',
      installed: true,
      active: publishing && available > 0,
      modelId: `${available} models`,
      applyLabel: 'Set up',
      idleText: publishing ? 'no models published yet' : 'using its own defaults',
      detail: 'Pick them under Manage Models → ChatGPT Maestro in the chat model picker.',
    };

    const utilityOverride = readUtilitySmallModel();
    const utilityModel = utilityOverride
      ? catalog.listAll().find((model) => model.id === utilityOverride.id)
      : undefined;

    const utilityRow = {
      target: 'commitMessages',
      label: 'Commit messages',
      installed: true,
      active: utilityOverride !== undefined && utilityModel !== undefined && publishing,
      modelId: utilityModel?.displayName ?? utilityOverride?.id,
      applyLabel: utilityOverride ? 'Change model' : 'Use model',
      idleText: utilityOverride === undefined ? 'billed to Copilot' : 'model unavailable',
      detail: 'Runs background tasks (like commit messages) on ChatGPT models without spending Copilot credits.',
    };

    return {
      gateway: gateway.running ? { running: true, port: 8766 } : { running: false },
      integrations: [
        copilotRow,
        utilityRow,
        ...(await Promise.all(
          integrations.map(async (integration) => {
            const status = await integration.getStatus();
            return { ...status, label: AGENT_LABELS[integration.target] };
          }),
        )),
      ],
    };
  });

  const userClaudeHeaders = process.env[CLAUDE_HEADERS_ENV];
  const terminalEnv = context.environmentVariableCollection;
  terminalEnv.description = 'Names this window to ChatGPT Maestro';
  process.env[WINDOW_ENV] = accounts.windowKey;
  terminalEnv.replace(WINDOW_ENV, accounts.windowKey);

  const seedAgentEnv = async (): Promise<void> => {
    try {
      const [claudeStatus, codexStatus] = await Promise.all([claudeCode.getStatus(), codex.getStatus()]);

      const headers = withWindowHeader(
        userClaudeHeaders,
        claudeStatus.active ? accounts.windowKey : undefined,
      );
      if (headers === undefined) {
        delete process.env[CLAUDE_HEADERS_ENV];
      } else {
        process.env[CLAUDE_HEADERS_ENV] = headers;
      }
      if (claudeStatus.active && headers !== undefined) {
        terminalEnv.replace(CLAUDE_HEADERS_ENV, headers);
      } else {
        terminalEnv.delete(CLAUDE_HEADERS_ENV);
      }

      const endpoint = gateway.endpoint();
      if (!endpoint) return;

      let changed = false;
      if (codexStatus.active) {
        codex.seedProcessEnv(endpoint.apiKey);
        changed = (await codex.syncEndpoint(endpoint)) || changed;
      }
      if (claudeStatus.active) {
        changed = (await claudeCode.syncEndpoint(endpoint)) || changed;
      }
      if (changed) {
        void accountsView.postState();
      }
    } catch (error) {
      Logger.warn('Could not prepare the agent environment', error);
    }
  };

  context.subscriptions.push(
    history,
    accounts,
    gateway,
    accountsView,
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, accountsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.lm.registerLanguageModelChatProvider(CHAT_PROVIDER_VENDOR, chatProvider),
    accounts.onDidChange(() => chatProvider.refresh()),
    gateway.onDidChange(() => {
      void accountsView.postState();
      void seedAgentEnv();
    }),
  );

  registerCommands(context, {
    accounts,
    accountsView,
    catalog,
    chatProvider,
    coordinator,
    gateway,
    claudeCode,
    codex,
    integrations,
    seedAgentEnv,
  });

  accounts.startAutoRefresh();

  if (Config.gatewayAutoStart()) {
    gateway.start().catch((error) => {
      Logger.error('Gateway failed to start', error);
    });
  }
  void seedAgentEnv();

  if (accounts.list().length > 0) {
    void accounts.refreshAllQuotas();
  }

  Logger.info('ChatGPT Maestro activated successfully');
}

interface CommandDeps {
  accounts: AccountManager;
  accountsView: AccountsViewProvider;
  catalog: ModelCatalog;
  chatProvider: ChatGPTChatProvider;
  coordinator: CoordinatorService;
  gateway: GatewayManager;
  claudeCode: ClaudeCodeIntegration;
  codex: CodexIntegration;
  integrations: AgentIntegration[];
  seedAgentEnv: () => Promise<void>;
}

function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const {
    accounts,
    accountsView,
    catalog,
    chatProvider,
    coordinator,
    gateway,
    claudeCode,
    codex,
    integrations: _integrations,
  } = deps;

  const register = (command: string, handler: (...args: any[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: any[]) => {
        try {
          return await handler(...args);
        } catch (error: any) {
          Logger.error(`${command} failed: ${error.message}`, error);
          vscode.window.showErrorMessage(`ChatGPT Maestro: ${error.message}`);
          return undefined;
        }
      }),
    );
  };

  register('chatgptMaestro.openAccounts', () => accountsView.openAsPanel());
  register('chatgptMaestro.showLogs', () => Logger.show());

  register('chatgptMaestro.addAccount', async () => {
    const account = await accounts.addAccount();
    if (account) {
      vscode.window.showInformationMessage(`Connected ChatGPT account: ${account.email}`);
    }
  });

  register('chatgptMaestro.addAccountToken', async () => {
    const account = await accounts.addAccountWithToken();
    if (account) {
      vscode.window.showInformationMessage(`Connected ChatGPT account: ${account.email}`);
    }
  });

  register('chatgptMaestro.refreshQuotas', async () => {
    if (accounts.list().length === 0) {
      vscode.window.showInformationMessage('Add a ChatGPT account first.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Refreshing ChatGPT accounts…' },
      () => accounts.refreshAllQuotas(),
    );
  });

  register('chatgptMaestro.switchAccount', async () => {
    const all = accounts.list();
    if (all.length === 0) {
      vscode.window.showInformationMessage('No ChatGPT account added yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      all.map((a) => ({
        label: a.email,
        description: a.subscriptionTier?.toUpperCase(),
        detail: a.id === accounts.getActive()?.id ? '(Active Account)' : '',
        id: a.id,
      })),
      { placeHolder: 'Select active ChatGPT account' },
    );
    if (picked) {
      await accounts.setActive(picked.id);
      vscode.window.showInformationMessage(`ChatGPT Maestro switched to ${picked.label}`);
    }
  });

  register('chatgptMaestro.removeAccount', async (accountId?: string) => {
    const all = accounts.list();
    const target = accountId
      ? accounts.get(accountId)
      : all.length === 1
        ? all[0]
        : (
            await vscode.window.showQuickPick(
              all.map((a) => ({ label: a.email, id: a.id })),
              { placeHolder: 'Select ChatGPT account to remove' },
            )
          )?.id
          ? accounts.get(
              (
                await vscode.window.showQuickPick(
                  all.map((a) => ({ label: a.email, id: a.id })),
                  { placeHolder: 'Select ChatGPT account to remove' },
                )
              )!.id,
            )
          : undefined;

    if (!target) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove ChatGPT account ${target.email}?`,
      { modal: true },
      'Remove',
    );
    if (confirm === 'Remove') {
      await accounts.removeAccount(target.id);
      vscode.window.showInformationMessage(`Removed ${target.email}`);
    }
  });

  // ── Coordinator Commands ───────────────────────────────────────────────────

  register('chatgptMaestro.coordinator.createTask', async () => {
    const title = await vscode.window.showInputBox({
      title: 'Create Coordinator Task',
      prompt: 'Enter task title',
    });
    if (!title) return;

    const description = await vscode.window.showInputBox({
      title: 'Task Description',
      prompt: 'Enter detailed task description or requirements',
    });
    if (!description) return;

    const availableModels = await coordinator.listAvailableModels();
    const modelItems = [
      { label: '$(gear) Unassigned / Auto', id: '' },
      ...availableModels.map((m) => ({
        label: `${m.name || m.id} (${m.vendor})`,
        description: m.id,
        id: m.id,
      })),
    ];

    const pickedModel = await vscode.window.showQuickPick(modelItems, {
      placeHolder: 'Select an assignee model (optional)',
    });

    const task = coordinator.createTask(title, description, pickedModel?.id || undefined);
    vscode.window.showInformationMessage(`Created coordinator task: ${task.id} (${task.title})`);
  });

  register('chatgptMaestro.coordinator.delegateToModel', async () => {
    const tasks = coordinator.listTasks('open');
    if (tasks.length === 0) {
      vscode.window.showInformationMessage('No open coordinator tasks available to delegate.');
      return;
    }

    const pickedTask = await vscode.window.showQuickPick(
      tasks.map((t) => ({ label: t.title, description: t.priority, detail: t.description, id: t.id })),
      { placeHolder: 'Choose a task to delegate' },
    );
    if (!pickedTask) return;

    const availableModels = await coordinator.listAvailableModels();
    if (availableModels.length === 0) {
      vscode.window.showErrorMessage('No other language models detected in VS Code.');
      return;
    }

    const pickedModel = await vscode.window.showQuickPick(
      availableModels.map((m) => ({
        label: `${m.name || m.id} (${m.vendor})`,
        description: m.id,
        id: m.id,
      })),
      { placeHolder: 'Select the model to run this task on' },
    );
    if (!pickedModel) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running task "${pickedTask.label}" on ${pickedModel.label}…`,
      },
      async () => {
        await coordinator.delegateTask(pickedTask.id, pickedModel.id);
        vscode.window.showInformationMessage(`Task completed by ${pickedModel.id}! Check result in Coordinator.`);
      },
    );
  });

  // ── Gateway ────────────────────────────────────────────────────────────────

  register('chatgptMaestro.restartGateway', async () => {
    const endpoint = await gateway.restart();
    vscode.window.showInformationMessage(`ChatGPT Maestro gateway running at ${endpoint.baseUrl}`);
  });

  register('chatgptMaestro.copyGatewayInfo', async () => {
    const endpoint = gateway.endpoint() ?? (await gateway.start());
    await vscode.env.clipboard.writeText(`${endpoint.baseUrl}\n${endpoint.apiKey}`);
    vscode.window.showInformationMessage(`Copied gateway URL and key to clipboard (${endpoint.baseUrl}).`);
  });

  // ── Agent integrations ─────────────────────────────────────────────────────

  register('chatgptMaestro.claudeCode.apply', () => applyToAgent(claudeCode, 'Claude Code', deps));
  register('chatgptMaestro.claudeCode.restore', () => restoreAgent(claudeCode, 'Claude Code', deps));
  register('chatgptMaestro.codex.apply', () => applyToAgent(codex, 'Codex', deps));
  register('chatgptMaestro.codex.restore', () => restoreAgent(codex, 'Codex', deps));

  register('chatgptMaestro.copilot.setup', () => setUpCopilot(catalog, chatProvider, context, accountsView));
  register('chatgptMaestro.copilot.restore', () => restoreCopilot(chatProvider, context, accountsView));
  register('chatgptMaestro.commitMessages.apply', () => applyUtilityModel(catalog, chatProvider, context, accountsView));
  register('chatgptMaestro.commitMessages.restore', () => restoreUtilityModel(context, accountsView));

  register('chatgptMaestro.showStatus', async () => {
    const lines: string[] = [];
    const active = accounts.getActive();
    lines.push(active ? `Account: ${active.email} (${active.subscriptionTier?.toUpperCase()})` : 'Account: none');
    lines.push(gateway.running ? `Gateway: ${gateway.endpoint()!.baseUrl}` : 'Gateway: stopped');
    lines.push(`Models: ${catalog.listAll().length}`);
    vscode.window.showInformationMessage(`ChatGPT Maestro — ${lines.join(' · ')}`);
  });
}

async function setUpCopilot(
  catalog: ModelCatalog,
  chatProvider: ChatGPTChatProvider,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const available = catalog.listAll();
  chatProvider.setPublished(true);
  await context.globalState.update(COPILOT_PUBLISH_KEY, true);
  await ensureByokUtilityDefault(context);
  await vscode.commands.executeCommand('workbench.action.chat.openModelPicker');
  void accountsView.postState();
  vscode.window.showInformationMessage(
    `${available.length} ChatGPT models published. In the model picker, choose Manage Models → ChatGPT Maestro.`,
  );
}

async function restoreCopilot(
  chatProvider: ChatGPTChatProvider,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  chatProvider.setPublished(false);
  await context.globalState.update(COPILOT_PUBLISH_KEY, false);
  await restoreByokUtilityDefault(context);
  await clearUtilityModel(context);
  void accountsView.postState();
  vscode.window.showInformationMessage('Copilot Chat restored to its defaults.');
}

async function applyUtilityModel(
  catalog: ModelCatalog,
  chatProvider: ChatGPTChatProvider,
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    catalog.listAll().map((m) => ({ label: m.displayName, id: m.id })),
    { placeHolder: 'Select ChatGPT model for background chores' },
  );
  if (!picked) return;

  chatProvider.setPublished(true);
  await context.globalState.update(COPILOT_PUBLISH_KEY, true);
  await writeUtilityModel(picked.id, context);
  void accountsView.postState();
  vscode.window.showInformationMessage(`Commit messages now use ${picked.label}.`);
}

async function restoreUtilityModel(
  context: vscode.ExtensionContext,
  accountsView: AccountsViewProvider,
): Promise<void> {
  await clearUtilityModel(context);
  void accountsView.postState();
  vscode.window.showInformationMessage('Commit messages restored to Copilot default.');
}

async function writeUtilityModel(modelId: string, context: vscode.ExtensionContext): Promise<void> {
  const value = `${CHAT_PROVIDER_VENDOR}/${modelId}`;
  const config = vscode.workspace.getConfiguration();
  for (const setting of UTILITY_SETTINGS) {
    await config.update(setting, value, vscode.ConfigurationTarget.Global);
  }
  await context.globalState.update(UTILITY_SMALL_KEY, value);
}

async function clearUtilityModel(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const ours = context.globalState.get<string>(UTILITY_SMALL_KEY);
  for (const setting of UTILITY_SETTINGS) {
    if (config.inspect<string>(setting)?.globalValue === ours) {
      await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
    }
  }
  await context.globalState.update(UTILITY_SMALL_KEY, undefined);
}

function readUtilitySmallModel(): { id: string } | undefined {
  const value = vscode.workspace.getConfiguration().get<string>(UTILITY_SMALL_SETTING);
  if (!value || !value.startsWith(`${CHAT_PROVIDER_VENDOR}/`)) return undefined;
  return { id: value.slice(CHAT_PROVIDER_VENDOR.length + 1) };
}

async function ensureByokUtilityDefault(context: vscode.ExtensionContext): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration();
    if (!config.inspect('chat.byokUtilityModelDefault')?.globalValue) {
      await config.update('chat.byokUtilityModelDefault', 'mainAgent', vscode.ConfigurationTarget.Global);
      await context.globalState.update(COPILOT_UTILITY_KEY, true);
    }
  } catch {}
}

async function restoreByokUtilityDefault(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(COPILOT_UTILITY_KEY)) {
    try {
      await vscode.workspace.getConfiguration().update('chat.byokUtilityModelDefault', undefined, vscode.ConfigurationTarget.Global);
    } catch {}
    await context.globalState.update(COPILOT_UTILITY_KEY, undefined);
  }
}

async function applyToAgent(
  integration: AgentIntegration,
  label: string,
  deps: CommandDeps,
): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    deps.catalog.listAll().map((m) => ({ label: m.displayName, id: m.id, maxInput: m.maxInputTokens, maxOutput: m.maxOutputTokens })),
    { placeHolder: `Select model for ${label}` },
  );
  if (!picked) return;

  const endpoint = deps.gateway.endpoint() ?? (await deps.gateway.start());
  await integration.apply(picked.id, endpoint, {
    maxInputTokens: picked.maxInput,
    maxOutputTokens: picked.maxOutput,
  });

  void deps.accountsView.postState();
  await deps.seedAgentEnv();
  vscode.window.showInformationMessage(`${label} now configured to use ${picked.label} via ChatGPT Maestro gateway.`);
}

async function restoreAgent(
  integration: AgentIntegration,
  label: string,
  deps: CommandDeps,
): Promise<void> {
  await integration.restore();
  void deps.accountsView.postState();
  await deps.seedAgentEnv();
  vscode.window.showInformationMessage(`${label} restored to default settings.`);
}

export function deactivate(): void {
  Logger.info('ChatGPT Maestro deactivating');
  Logger.dispose();
}
