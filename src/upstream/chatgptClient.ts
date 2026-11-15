import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';
import { getSentinelHeaders } from './sentinel';

export class ChatGPTError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = 'ChatGPTError';
  }
}

export class RateLimitError extends ChatGPTError {
  constructor(message: string, public readonly retryAfterSeconds = 60) {
    super(message, 429, 'rate_limit_exceeded');
    this.name = 'RateLimitError';
  }
}

export class AuthError extends ChatGPTError {
  constructor(message: string) {
    super(message, 401, 'unauthorized');
    this.name = 'AuthError';
  }
}

export interface StreamOptions {
  model: string;
  prompt: string;
  conversationId?: string;
  parentMessageId?: string;
  accessToken: string;
  cookies?: string;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
  onThought?: (thoughtDelta: string) => void;
  historyAndTrainingDisabled?: boolean;
}

export interface ChatResponseResult {
  fullText: string;
  thoughtText: string;
  conversationId?: string;
  messageId?: string;
  inputTokens: number;
  outputTokens: number;
}

export class ChatGPTClient {
  private readonly baseUrl = 'https://chatgpt.com';

  /**
   * Sends a conversation message and streams text and reasoning deltas.
   */
  async sendMessageStream(options: StreamOptions): Promise<ChatResponseResult> {
    const {
      model,
      prompt,
      conversationId,
      parentMessageId,
      accessToken,
      cookies,
      signal,
      onChunk,
      onThought,
      historyAndTrainingDisabled = true,
    } = options;

    if (!cookies) {
      return await this.sendOpenAIMessageStream(options);
    }

    const messageId = randomUUID();
    const parentId = parentMessageId || randomUUID();

    const requestBody = {
      action: 'next',
      messages: [
        {
          id: messageId,
          author: { role: 'user' },
          content: {
            content_type: 'text',
            parts: [prompt],
          },
          metadata: {},
        },
      ],
      parent_message_id: parentId,
      model: this.canonicalModelName(model),
      timezone_offset_min: new Date().getTimezoneOffset(),
      suggestions: [],
      history_and_training_disabled: historyAndTrainingDisabled,
      conversation_mode: { kind: 'primary_assistant' },
      force_paragen: false,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    };

    const sentinelHeaders = await getSentinelHeaders(accessToken, cookies);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      Referer: 'https://chatgpt.com/',
      ...sentinelHeaders,
    };

    if (cookies) {
      headers['Cookie'] = cookies;
    }

    Logger.debug(`Sending ChatGPT conversation request (model: ${requestBody.model})`);

    const res = await fetch(`${this.baseUrl}/backend-api/conversation`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`ChatGPT authentication error (${res.status}): ${errText || res.statusText}`);
      }
      if (res.status === 429) {
        throw new RateLimitError(
          `ChatGPT rate limit or quota exceeded (429): ${errText || 'Please try again later or switch accounts.'}`,
        );
      }
      throw new ChatGPTError(`ChatGPT request failed (HTTP ${res.status}): ${errText || res.statusText}`, res.status);
    }

    if (!res.body) {
      throw new ChatGPTError('ChatGPT response body is empty.');
    }

    let fullText = '';
    let thoughtText = '';
    let lastLength = 0;
    let lastThoughtLength = 0;
    let finalConversationId = conversationId;
    let finalMessageId: string | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            break;
          }

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.conversation_id) {
              finalConversationId = parsed.conversation_id;
            }

            if (parsed.error) {
              const errMsg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
              if (parsed.error.code === 'usage_limit_reached' || /limit/i.test(errMsg)) {
                throw new RateLimitError(errMsg);
              }
              throw new ChatGPTError(errMsg);
            }

            const msg = parsed.message;
            if (msg) {
              if (msg.id) {
                finalMessageId = msg.id;
              }

              // Handle reasoning/thought output
              if (msg.metadata?.thought && onThought) {
                const thought = String(msg.metadata.thought);
                if (thought.length > lastThoughtLength) {
                  const thoughtDelta = thought.slice(lastThoughtLength);
                  thoughtText += thoughtDelta;
                  lastThoughtLength = thought.length;
                  onThought(thoughtDelta);
                }
              }

              // Handle main message text
              const parts = msg.content?.parts;
              if (Array.isArray(parts) && typeof parts[0] === 'string') {
                const currentText = parts[0];
                if (currentText.length > lastLength) {
                  const delta = currentText.slice(lastLength);
                  fullText += delta;
                  lastLength = currentText.length;
                  onChunk(delta);
                }
              }
            }
          } catch (e) {
            if (e instanceof ChatGPTError) throw e;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const inputTokens = Math.ceil(prompt.length / 3.7);
    const outputTokens = Math.ceil(fullText.length / 3.7) + Math.ceil(thoughtText.length / 3.7);

    return {
      fullText,
      thoughtText,
      conversationId: finalConversationId,
      messageId: finalMessageId,
      inputTokens,
      outputTokens,
    };
  }

  /**
   * Sends chat message via OpenAI API completions endpoint for OAuth accounts (no web cookies).
   */
  private async sendOpenAIMessageStream(options: StreamOptions): Promise<ChatResponseResult> {
    const { model, prompt, accessToken, signal, onChunk, onThought } = options;
    const canonicalModel = this.canonicalModelName(model) === 'auto' ? 'gpt-4o' : this.canonicalModelName(model);

    Logger.debug(`Sending OpenAI completions request (model: ${canonicalModel})`);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: canonicalModel,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(`ChatGPT authentication error (${res.status}): ${errText || res.statusText}`);
      }
      if (res.status === 429) {
        throw new RateLimitError(
          `ChatGPT rate limit or quota exceeded (429): ${errText || 'Please try again later or switch accounts.'}`,
        );
      }
      throw new ChatGPTError(`ChatGPT request failed (HTTP ${res.status}): ${errText || res.statusText}`, res.status);
    }

    if (!res.body) {
      throw new ChatGPTError('ChatGPT response body is empty.');
    }

    let fullText = '';
    let thoughtText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content && onThought) {
                const thoughtDelta = String(delta.reasoning_content);
                thoughtText += thoughtDelta;
                onThought(thoughtDelta);
              }
              if (delta.content) {
                const contentDelta = String(delta.content);
                fullText += contentDelta;
                onChunk(contentDelta);
              }
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    const inputTokens = Math.ceil(prompt.length / 3.7);
    const outputTokens = Math.ceil(fullText.length / 3.7) + Math.ceil(thoughtText.length / 3.7);

    return {
      fullText,
      thoughtText,
      inputTokens,
      outputTokens,
    };
  }

  /**
   * Normalizes model ID to ChatGPT web model name.
   */
  private canonicalModelName(id: string): string {
    const clean = id.replace(/^chatgpt\//, '').toLowerCase();
    if (clean.includes('o3-mini')) return 'o3-mini';
    if (clean.includes('o1-mini')) return 'o1-mini';
    if (clean.includes('o1')) return 'o1';
    if (clean.includes('4o-mini')) return 'gpt-4o-mini';
    if (clean.includes('4o')) return 'gpt-4o';
    if (clean.includes('gpt-4')) return 'gpt-4';
    if (clean.includes('auto')) return 'auto';
    return 'gpt-4o';
  }
}
