import * as http from 'http';
import { AddressInfo } from 'net';
import { Logger } from '../utils/logger';

/** Ports allowed by OpenAI OAuth loopback redirect URI list. */
export const CANDIDATE_PORTS = [1455, 1457];
export const CALLBACK_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoopbackSession {
  redirectUri: string;
  waitForCode(): Promise<string>;
  dispose(): void;
}

/**
 * Start a one-shot loopback listener for the OAuth redirect.
 * Binds to 127.0.0.1 on port 1455 (or 1457 if busy).
 */
export async function startLoopbackServer(
  state: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LoopbackSession> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  let settled = false;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const returnedState = url.searchParams.get('state');

    if (code && returnedState !== state) {
      respond(res, 400, 'Sign-in failed', 'The sign-in state did not match. Please try again.');
      settle(() => rejectCode?.(new Error('OAuth state mismatch')));
      return;
    }

    if (code) {
      respond(
        res,
        200,
        'Signed in to ChatGPT',
        'You can close this tab and return to VS Code.',
      );
      settle(() => resolveCode?.(code));
      return;
    }

    respond(res, 400, 'Sign-in failed', escapeHtml(error ?? 'No authorization code was returned.'));
    settle(() => rejectCode?.(new Error(error ?? 'No authorization code was returned')));
  });

  const port = await listenOnFirstFreePort(server);
  Logger.info(`ChatGPT OAuth loopback listening on http://127.0.0.1:${port}${CALLBACK_PATH}`);

  const timer = setTimeout(() => {
    settle(() => rejectCode?.(new Error('Timed out waiting for ChatGPT sign-in')));
  }, timeoutMs);
  timer.unref?.();

  const dispose = () => {
    clearTimeout(timer);
    settle(() => rejectCode?.(new Error('Sign-in cancelled')));
    server.closeAllConnections?.();
    server.close(() => Logger.debug('OAuth loopback stopped'));
  };

  codePromise.catch(() => undefined);

  return {
    redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
    waitForCode: () => codePromise.finally(() => clearTimeout(timer)),
    dispose,
  };
}

async function listenOnFirstFreePort(server: http.Server): Promise<number> {
  for (const port of CANDIDATE_PORTS) {
    const bound = await tryListen(server, port);
    if (bound) {
      return (server.address() as AddressInfo).port;
    }
  }
  throw new Error(
    `No free port for the ChatGPT OAuth callback (tried ${CANDIDATE_PORTS.join(', ')}). ` +
      'Please close any application using these ports.',
  );
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      resolve(false);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function respond(res: http.ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      '<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:64px;background:#0d1117;color:#e6edf3">' +
      `<h1 style="font-weight:600;color:#10a37f">${escapeHtml(title)}</h1><p style="color:#8b949e">${escapeHtml(message)}</p>` +
      '<script>setTimeout(function(){window.close();},2500)</script></body></html>',
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
