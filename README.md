<h1 align="center">ChatGPT Maestro</h1>

<p align="center">
  <b>Run ChatGPT (OpenAI) models in Copilot Chat, Claude Code, and Codex without an API key using browser login.</b><br/>
  Multi-account rotation, quota tracking, and agent coordinator to delegate tasks across all available models.
</p>

---

## Highlights

- 🌐 **Browser Login (No API Key Required)**: Sign in directly via your browser (Microsoft Edge or Google Chrome). Your session is captured and kept fresh automatically. Alternatively, paste your session token or cookie.
- ⚡ **Flagship ChatGPT Models**:
  - `chatgpt-maestro/gpt-4o` (GPT-4o Omni)
  - `chatgpt-maestro/o3-mini` (Fast reasoning with thought streaming)
  - `chatgpt-maestro/o1` (Deep reasoning)
  - `chatgpt-maestro/gpt-4o-mini` (Fast & lightweight)
  - `chatgpt-maestro/o1-mini` (Math & coding reasoning)
  - `chatgpt-maestro/auto` (Automatic model selection)
- 🤝 **Agent Coordinator & Cross-Model Task Delegation**:
  - Built-in integration with the shared task queue (`.agent-coordinator/tasks.json`).
  - Discovers all other models available in VS Code (Antigravity Maestro, OpenRouter Maestro, Copilot).
  - Delegate subtasks from ChatGPT to other models with 1-click execution or via Language Model Tools (`chatgpt_delegateTask`).
- 🔄 **Multi-Account Rotation**: Pool multiple ChatGPT accounts (Free, Plus, Team, Pro). If one account hits rate limits, requests rotate seamlessly to the next.
- 🚀 **Universal Agent Compatibility**:
  - **VS Code Copilot Chat**: Native model provider in the model picker.
  - **Claude Code**: Points `ANTHROPIC_BASE_URL` to local gateway (`http://127.0.0.1:8766`).
  - **Codex CLI**: Points `OPENAI_BASE_URL` or `~/.codex/config.toml` to local gateway.

---

## Quick Start

### 1. Connect Account via Browser Login

1. Open the **ChatGPT Maestro** panel from the VS Code Activity Bar.
2. Click **Log in with Browser** (`+`).
3. An Edge/Chrome browser window opens to `https://chatgpt.com/auth/login`. Complete sign-in (Google, Microsoft, Apple, email, or Turnstile).
4. ChatGPT Maestro automatically captures the session, detects your plan (Free, Plus, Team, Pro), and securely stores your credentials in VS Code SecretStorage.
5. *(Optional)* If you prefer, click the paste button to enter your `__Secure-next-auth.session-token` or access token manually.

### 2. Use in Copilot Chat

1. In the ChatGPT Maestro sidebar or Command Palette, run **ChatGPT Maestro: Set Up Copilot Chat**.
2. Open Copilot Chat (`Ctrl+Alt+I` or `Cmd+Alt+I`).
3. In the model picker, select **Manage Models → ChatGPT Maestro**, and select **GPT-4o**, **o3-mini**, or **o1**.

### 3. Agent Coordinator & Cross-Model Delegation

ChatGPT Maestro includes a full **Coordinator** tab to exchange and delegate tasks across all models available in your VS Code workspace:

- View, create, and track tasks stored in `.agent-coordinator/tasks.json`.
- See all detected models across your extensions (e.g. `antigravity-maestro/*`, `openrouter-maestro/*`, `copilot/*`).
- Click **Run with Model** on any task to execute it using a chosen model and record the result!
- Language Model Tools for Copilot Chat:
  - `chatgpt_delegateTask`: Assign a subtask or coding review to another model.
  - `chatgpt_listAvailableModels`: List all active models across VS Code.
  - `chatgpt_coordinatorCreateTask`: Add a task to the coordinator queue.
  - `chatgpt_coordinatorListTasks`: List current tasks.

### 4. Claude Code & Codex CLI Integration

- **Claude Code**: Run `ChatGPT Maestro: Use Model in Claude Code` to wire your local Claude Code CLI to ChatGPT models.
- **Codex**: Run `ChatGPT Maestro: Use Model in Codex` to point Codex to the local gateway.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `chatgptMaestro.gateway.port` | `8766` | Preferred port for local gateway. |
| `chatgptMaestro.gateway.autoStart` | `true` | Start gateway on launch. |
| `chatgptMaestro.browser.path` | `""` | Custom path to Edge or Chrome. Auto-detected when empty. |
| `chatgptMaestro.rotation.strategy` | `highest-quota-first` | Rotation strategy: `highest-quota-first`, `round-robin`, or `manual`. |
| `chatgptMaestro.quota.autoRefreshMinutes` | `10` | Frequency of background session & status checks. |
| `chatgptMaestro.saveHistoryInChatGPTWeb` | `false` | Save API chats to chatgpt.com web sidebar. |

---

## License

MIT
