import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import {
  decodeJwtPayload,
  extractSubscriptionTier,
  ResolvedAccountSession,
} from './sessionAuth';
import { AccountMetadata, StoredSession } from '../accounts/types';

interface CdpTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class BrowserLoginService {
  /**
   * Find path to an installed browser (Edge or Chrome).
   */
  static findBrowserExecutable(configuredPath?: string): string | undefined {
    if (configuredPath && fs.existsSync(configuredPath)) {
      return configuredPath;
    }

    const platform = process.platform;
    const candidates: string[] = [];

    if (platform === 'win32') {
      const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
      const localAppData = process.env['LOCALAPPDATA'] ?? '';

      candidates.push(
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      );
    } else {
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      );
    }

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }

    return undefined;
  }

  /**
   * Run the browser login flow. Launches Edge/Chrome, opens chatgpt.com,
   * monitors for successful session via CDP, and returns the resolved account session.
   */
  static async loginWithBrowser(
    cancellationToken: vscode.CancellationToken,
    configuredBrowserPath?: string,
  ): Promise<ResolvedAccountSession> {
    const browserPath = this.findBrowserExecutable(configuredBrowserPath);
    if (!browserPath) {
      throw new Error(
        'Could not locate Microsoft Edge or Google Chrome on your system. Please install one or configure `chatgptMaestro.browser.path`.',
      );
    }

    const port = 9333 + Math.floor(Math.random() * 100);
    const profileDir = path.join(os.homedir(), '.chatgpt-maestro', 'browser-profile');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    Logger.info(`Launching browser for login: ${browserPath} (CDP port ${port})`);

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://chatgpt.com/auth/login',
    ];

    let browserProc: ChildProcess | undefined;
    try {
      browserProc = spawn(browserPath, args, {
        detached: false,
        stdio: 'ignore',
      });
    } catch (err: any) {
      throw new Error(`Failed to launch browser (${browserPath}): ${err.message}`);
    }

    const cleanup = () => {
      if (browserProc && !browserProc.killed) {
        try {
          browserProc.kill();
        } catch {}
      }
    };

    cancellationToken.onCancellationRequested(() => {
      cleanup();
    });

    try {
      return await this.waitForLogin(port, cancellationToken, cleanup);
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  /**
   * Polls CDP until login completes on chatgpt.com.
   */
  private static async waitForLogin(
    port: number,
    cancellationToken: vscode.CancellationToken,
    cleanup: () => void,
  ): Promise<ResolvedAccountSession> {
    const startTime = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes timeout

    // Wait for CDP endpoint to become ready
    let targetWsUrl: string | undefined;
    while (Date.now() - startTime < timeoutMs) {
      if (cancellationToken.isCancellationRequested) {
        throw new Error('Sign-in cancelled by user.');
      }

      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) {
          const tabs = (await res.json()) as CdpTab[];
          const chatTab =
            tabs.find((t) => t.url.includes('chatgpt.com') || t.url.includes('openai.com')) ||
            tabs[0];
          if (chatTab && chatTab.webSocketDebuggerUrl) {
            targetWsUrl = chatTab.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!targetWsUrl) {
      throw new Error('Timed out connecting to the login browser.');
    }

    // Connect to the page via WebSocket to evaluate /api/auth/session inside the browser
    return new Promise<ResolvedAccountSession>((resolve, reject) => {
      let ws: WebSocket | undefined;
      let checkInterval: NodeJS.Timeout | undefined;

      const finish = (result?: ResolvedAccountSession, error?: Error) => {
        if (checkInterval) clearInterval(checkInterval);
        if (ws) {
          try {
            ws.close();
          } catch {}
        }
        cleanup();
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };

      try {
        ws = new WebSocket(targetWsUrl!);
      } catch (err: any) {
        finish(undefined, new Error(`Could not connect to browser debugger: ${err.message}`));
        return;
      }

      let msgId = 1;
      const pendingCallbacks = new Map<number, (res: any) => void>();

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data.toString());
          if (data.id && pendingCallbacks.has(data.id)) {
            const cb = pendingCallbacks.get(data.id)!;
            pendingCallbacks.delete(data.id);
            cb(data);
          }
        } catch {}
      };

      ws.onerror = (err) => {
        Logger.warn(`Browser CDP WebSocket error: ${String(err)}`);
      };

      ws.onopen = () => {
        // Send Runtime.evaluate to check /api/auth/session periodically
        checkInterval = setInterval(async () => {
          if (cancellationToken.isCancellationRequested) {
            finish(undefined, new Error('Sign-in cancelled by user.'));
            return;
          }
          if (Date.now() - startTime > timeoutMs) {
            finish(undefined, new Error('Timed out waiting for ChatGPT sign-in.'));
            return;
          }

          const callId = msgId++;
          const evalPayload = {
            id: callId,
            method: 'Runtime.evaluate',
            params: {
              expression: `(async () => {
                try {
                  const r = await fetch('/api/auth/session');
                  if (r.ok) {
                    const data = await r.json();
                    if (data && data.accessToken) {
                      return { session: data, cookies: document.cookie };
                    }
                  }
                } catch {}
                return null;
              })()`,
              awaitPromise: true,
              returnByValue: true,
            },
          };

          pendingCallbacks.set(callId, (response) => {
            const val = response.result?.result?.value;
            if (val && val.session && val.session.accessToken) {
              try {
                const s = val.session;
                const cookies: string = val.cookies || '';
                const jwt = decodeJwtPayload(s.accessToken);
                const tier = extractSubscriptionTier(jwt);
                const expiresAt = s.expires
                  ? Date.parse(s.expires)
                  : Date.now() + 24 * 60 * 60 * 1000;

                const match = cookies.match(/__Secure-next-auth\.session-token=([^;]+)/);
                const sessionToken = match ? match[1] : undefined;

                const account: AccountMetadata = {
                  id: s.user?.id || (jwt?.sub as string) || `user-${Date.now().toString(36)}`,
                  email: s.user?.email || (jwt?.email as string) || 'chatgpt-user@openai.com',
                  name: s.user?.name || (jwt?.name as string) || 'ChatGPT User',
                  picture: s.user?.picture || s.user?.image || (jwt?.picture as string),
                  subscriptionTier: tier,
                  authMethod: 'browser',
                  addedAt: Date.now(),
                  expiresAt,
                  needsReauth: false,
                };

                const session: StoredSession = {
                  accessToken: s.accessToken,
                  sessionToken,
                  cookies,
                  expiresAt,
                };

                finish({ account, session });
              } catch (parseErr: any) {
                finish(undefined, new Error(`Failed to parse session from browser: ${parseErr.message}`));
              }
            }
          });

          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(evalPayload));
          }
        }, 2000);
      };
    });
  }
}
