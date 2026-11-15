import * as vscode from 'vscode';
import { AccountLease } from '../accounts/accountLease';
import { GatewayEndpoint } from '../integrations/agentIntegration';
import { ChatGPTClient } from '../upstream/chatgptClient';
import { ModelCatalog } from '../upstream/modelCatalog';
import { Config } from '../utils/config';
import { randomToken } from '../utils/ids';
import { Logger } from '../utils/logger';
import { GatewayServer } from './server';

const API_KEY_SECRET = 'chatgpt.gatewayKey';

export class GatewayManager implements vscode.Disposable {
  private server: GatewayServer | undefined;
  private apiKey: string | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly lease: AccountLease,
    private readonly client: ChatGPTClient,
    private readonly catalog: ModelCatalog,
  ) {}

  get running(): boolean {
    return this.server?.running === true;
  }

  endpoint(): GatewayEndpoint | undefined {
    if (!this.server?.running || !this.apiKey) {
      return undefined;
    }
    return { baseUrl: this.server.url, apiKey: this.apiKey };
  }

  async start(): Promise<GatewayEndpoint> {
    if (this.server?.running) {
      return this.endpoint()!;
    }

    const apiKey = await this.ensureApiKey();
    const server = new GatewayServer({
      lease: this.lease,
      client: this.client,
      catalog: this.catalog,
      apiKey,
    });

    const preferred = Config.gatewayPort();
    await server.start(preferred);
    this.server = server;

    this.onDidChangeEmitter.fire();
    return this.endpoint()!;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
    this.onDidChangeEmitter.fire();
  }

  async restart(): Promise<GatewayEndpoint> {
    await this.stop();
    return this.start();
  }

  private async ensureApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const stored = await this.secrets.get(API_KEY_SECRET);
    if (stored) {
      this.apiKey = stored;
      return stored;
    }

    const generated = `cgm-${randomToken(24)}`;
    await this.secrets.store(API_KEY_SECRET, generated);
    Logger.info('Generated new local ChatGPT gateway key');
    this.apiKey = generated;
    return generated;
  }

  dispose(): void {
    void this.stop();
    this.onDidChangeEmitter.dispose();
  }
}
