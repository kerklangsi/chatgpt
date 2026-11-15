import * as vscode from 'vscode';
import { AccountLease } from '../accounts/accountLease';
import { ChatGPTClient } from '../upstream/chatgptClient';
import { ModelCatalog } from '../upstream/modelCatalog';
import { Logger } from '../utils/logger';

export class ChatGPTChatProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  private published = true;
  private readonly thinkingPartAvailable =
    typeof (vscode as any).LanguageModelThinkingPart === 'function';

  constructor(
    private readonly catalog: ModelCatalog,
    private readonly lease: AccountLease,
    private readonly client: ChatGPTClient,
  ) {}

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  get isPublishing(): boolean {
    return this.published;
  }

  setPublished(published: boolean): void {
    if (this.published === published) return;
    this.published = published;
    Logger.info(`ChatGPT models ${published ? 'published' : 'withdrawn'}`);
    this.refresh();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (!this.published) return [];

    const models = this.catalog.listAll();
    return models.map((m) => {
      const info: vscode.LanguageModelChatInformation = {
        id: m.id,
        name: m.displayName,
        family: 'ChatGPT',
        version: '1.0',
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          supportsThinking: m.supportsThinking,
        },
      } as any;
      return info;
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const formattedPrompt = this.formatMessages(messages);
    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    Logger.info(`Copilot Chat request -> ChatGPT model: ${model.id}`);

    await this.lease.run(
      model.id,
      async (ctx) => {
        let hasReportedAny = false;

        const result = await this.client.sendMessageStream({
          model: ctx.model.id,
          prompt: formattedPrompt,
          accessToken: ctx.accessToken,
          cookies: ctx.cookies,
          signal: abortController.signal,
          onChunk: (delta) => {
            if (delta) {
              hasReportedAny = true;
              progress.report(new vscode.LanguageModelTextPart(delta));
            }
          },
          onThought: (thoughtDelta) => {
            if (thoughtDelta && this.thinkingPartAvailable) {
              hasReportedAny = true;
              progress.report(new (vscode as any).LanguageModelThinkingPart(thoughtDelta));
            }
          },
        });

        if (!hasReportedAny && result.fullText) {
          progress.report(new vscode.LanguageModelTextPart(result.fullText));
        }

        await this.lease.recordUsage(ctx, result.inputTokens, result.outputTokens);
      },
      abortController.signal,
    );
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const str = typeof text === 'string' ? text : this.formatMessages([text]);
    return Math.ceil(str.length / 3.7);
  }

  private formatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const parts: string[] = [];
    for (const m of messages) {
      const role =
        m.role === vscode.LanguageModelChatMessageRole.User
          ? 'User'
          : m.role === vscode.LanguageModelChatMessageRole.Assistant
            ? 'Assistant'
            : 'System';

      const content = m.content
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          if ((part as any)?.value) {
            return (part as any).value;
          }
          return '';
        })
        .join('');

      parts.push(`${role}:\n${content}`);
    }
    return parts.join('\n\n');
  }
}
