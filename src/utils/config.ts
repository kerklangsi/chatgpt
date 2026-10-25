import * as vscode from 'vscode';

/** Typed access to the extension`'s `chatgptMaestro.*` settings. */
export const Config = {
  gatewayPort: (): number => get<number>('gateway.port', 8766),
  gatewayAutoStart: (): boolean => get<boolean>('gateway.autoStart', true),
  quotaAutoRefreshMinutes: (): number => get<number>('quota.autoRefreshMinutes', 10),
  rotationStrategy: (): 'manual' | 'round-robin' | 'highest-quota-first' =>
    get('rotation.strategy', 'highest-quota-first'),
  rotationCooldownMinutes: (): number => get<number>('rotation.cooldownMinutes', 15),
  rotationMaxWaitSeconds: (): number => get<number>('rotation.maxWaitSeconds', 60),
  browserPath: (): string => get<string>('browser.path', '').trim(),
  browserHeadless: (): boolean => get<boolean>('browser.headless', false),
  saveHistoryInChatGPTWeb: (): boolean => get<boolean>('saveHistoryInChatGPTWeb', false),
  claudeCodeSettingsScope: (): 'user' | 'project' => get('claudeCode.settingsScope', 'user'),
  claudeCodeSmallFastModel: (): string => get<string>('claudeCode.smallFastModel', '').trim(),
  codexConfigPath: (): string => get<string>('codex.configPath', '').trim(),
  reloadOnModelChange: (): 'prompt' | 'auto' | 'never' => get('reloadOnModelChange', 'prompt'),
};

function get<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('chatgptMaestro').get<T>(key, fallback);
}
