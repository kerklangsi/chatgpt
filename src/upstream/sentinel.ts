import * as crypto from 'crypto';
import { Logger } from '../utils/logger';

export interface SentinelRequirements {
  persona?: string;
  token?: string;
  proofofwork?: {
    required?: boolean;
    seed?: string;
    difficulty?: string;
  };
}

/**
 * Solves OpenAI Sentinel Proof-of-Work challenge if required.
 */
export function solveProofOfWork(seed: string, difficulty: string): string {
  const diffLen = difficulty.length;
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const candidate = `${seed}${nonce}`;
    const hash = crypto.createHash('sha256').update(candidate).digest('hex');
    if (hash.substring(0, diffLen) <= difficulty) {
      return Buffer.from(nonce.toString()).toString('base64');
    }
  }
  return Buffer.from('0').toString('base64');
}

/**
 * Obtains Sentinel token and proof token if needed from ChatGPT backend.
 */
export async function getSentinelHeaders(
  accessToken: string,
  cookieHeader?: string,
  _proxyUrl?: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  try {
    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      Referer: 'https://chatgpt.com/',
    };
    if (cookieHeader) {
      reqHeaders['Cookie'] = cookieHeader;
    }

    const res = await fetch('https://chatgpt.com/backend-api/sentinel/chat-requirements', {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({}),
    });

    if (res.ok) {
      const data = (await res.json()) as SentinelRequirements;
      if (data.token) {
        headers['openai-sentinel-chat-requirements-token'] = data.token;
      }
      if (data.proofofwork?.required && data.proofofwork.seed && data.proofofwork.difficulty) {
        const solved = solveProofOfWork(data.proofofwork.seed, data.proofofwork.difficulty);
        headers['openai-sentinel-proof-token'] = `gAAAAAB${solved}`;
      }
    }
  } catch (err: any) {
    Logger.debug(`Sentinel chat-requirements probe non-fatal: ${err.message}`);
  }

  return headers;
}
