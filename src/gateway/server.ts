import * as http from 'http';
import { randomUUID } from 'crypto';
import { AccountLease } from '../accounts/accountLease';
import { ChatGPTClient } from '../upstream/chatgptClient';
import { ModelCatalog } from '../upstream/modelCatalog';
import { Logger } from '../utils/logger';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface GatewayDeps {
  lease: AccountLease;
  client: ChatGPTClient;
  catalog: ModelCatalog;
  apiKey: string;
}

export class GatewayServer {
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly deps: GatewayDeps) {}

  get running(): boolean {
    return this.server !== undefined;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(preferredPort: number): Promise<number> {
    if (this.server) return this.port;

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        Logger.error('Unhandled gateway error', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: err.message, type: 'internal_server_error' } });
        }
      });
    });

    let port = preferredPort;
    for (let attempts = 0; attempts < 10; attempts++) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        this.port = port;
        this.server = server;
        Logger.info(`ChatGPT Maestro Gateway listening on http://127.0.0.1:${port}`);
        return port;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          port++;
        } else {
          throw err;
        }
      }
    }
    throw new Error('Could not bind gateway to any free port in range.');
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
      Logger.info('ChatGPT Maestro Gateway stopped.');
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      sendJson(res, 200, { status: 'ok', vendor: 'chatgpt-maestro', models: this.deps.catalog.listAll().length });
      return;
    }

    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { error: { message: 'Invalid or missing API key', type: 'authentication_error' } });
      return;
    }

    switch (route) {
      case 'GET /v1/models':
        sendJson(res, 200, this.listModels());
        return;
      case 'POST /v1/chat/completions':
        await this.handleChatCompletions(req, res);
        return;
      case 'POST /v1/messages':
        await this.handleAnthropicMessages(req, res);
        return;
      default:
        sendJson(res, 404, { error: { message: `No route for ${route}`, type: 'not_found' } });
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const auth = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    const apiKey = req.headers['x-api-key'];
    return auth === this.deps.apiKey || apiKey === this.deps.apiKey;
  }

  private listModels() {
    const created = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: this.deps.catalog.listAll().map((m) => ({
        id: m.id,
        object: 'model',
        created,
        owned_by: 'openai-chatgpt',
        display_name: m.displayName,
      })),
    };
  }

  private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body?.model || !Array.isArray(body.messages)) {
      sendJson(res, 400, { error: { message: 'model and messages array are required' } });
      return;
    }

    const prompt = formatOpenAIMessages(body.messages);
    const stream = body.stream === true;
    const reqId = `chatcmpl-${randomUUID()}`;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }

    try {
      await this.deps.lease.run(body.model, async (ctx) => {
        let fullText = '';
        const result = await this.deps.client.sendMessageStream({
          model: ctx.model.id,
          prompt,
          accessToken: ctx.accessToken,
          cookies: ctx.cookies,
          onChunk: (delta) => {
            fullText += delta;
            if (stream) {
              const chunk = {
                id: reqId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: ctx.model.id,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          },
        });

        if (stream) {
          const finalChunk = {
            id: reqId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: ctx.model.id,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          sendJson(res, 200, {
            id: reqId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: ctx.model.id,
            choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: result.inputTokens,
              completion_tokens: result.outputTokens,
              total_tokens: result.inputTokens + result.outputTokens,
            },
          });
        }

        await this.deps.lease.recordUsage(ctx, result.inputTokens, result.outputTokens);
      });
    } catch (err: any) {
      if (stream) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        res.end();
      } else {
        sendJson(res, 500, { error: { message: err.message } });
      }
    }
  }

  private async handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson(req);
    if (!body?.model || !Array.isArray(body.messages)) {
      sendJson(res, 400, { error: { message: 'model and messages array are required' } });
      return;
    }

    const prompt = formatAnthropicMessages(body.system, body.messages);
    const stream = body.stream === true;
    const msgId = `msg_${randomUUID()}`;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    }

    try {
      await this.deps.lease.run(body.model, async (ctx) => {
        let fullText = '';
        const result = await this.deps.client.sendMessageStream({
          model: ctx.model.id,
          prompt,
          accessToken: ctx.accessToken,
          cookies: ctx.cookies,
          onChunk: (delta) => {
            fullText += delta;
            if (stream) {
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } })}\n\n`);
            }
          },
        });

        if (stream) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: result.outputTokens } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          res.end();
        } else {
          sendJson(res, 200, {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: ctx.model.id,
            content: [{ type: 'text', text: fullText }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: result.inputTokens,
              output_tokens: result.outputTokens,
            },
          });
        }

        await this.deps.lease.recordUsage(ctx, result.inputTokens, result.outputTokens);
      });
    } catch (err: any) {
      if (stream) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: err.message } })}\n\n`);
        res.end();
      } else {
        sendJson(res, 500, { error: { message: err.message } });
      }
    }
  }
}

function sendJson(res: http.ServerResponse, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function formatOpenAIMessages(messages: any[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
}

function formatAnthropicMessages(system: string | undefined, messages: any[]): string {
  const parts: string[] = [];
  if (system) parts.push(`System: ${system}`);
  for (const m of messages) {
    const text = Array.isArray(m.content) ? m.content.map((c: any) => c.text || '').join('') : m.content;
    parts.push(`${m.role}: ${text}`);
  }
  return parts.join('\n\n');
}
