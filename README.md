<h1 align="center">ChatGPT</h1>

<p align="center">
  <b>Use ChatGPT models in VS Code with browser sign-in and account rotation.</b><br/>
  Connect multiple accounts, track their quotas, and use them from Copilot Chat, Claude Code, and Codex.
</p>

---

## Highlights

- 🌐 **Browser Login (OAuth with Local Callback)**: Opens your system default browser (Brave, Chrome, Edge, etc.) just like its sister extension Antigravity (`kerklangsi.antigravity`). Once you log in or approve, the local callback server receives the authorization, completes PKCE exchange, and securely stores the credentials in VS Code SecretStorage.
- ⚡ **Flagship ChatGPT Models**:
  - `chatgpt/gpt-4o` (GPT-4o Omni)
  - `chatgpt/o3-mini` (Fast reasoning with thought streaming)
  - `chatgpt/o1` (Deep reasoning)
  - `chatgpt/gpt-4o-mini` (Fast & lightweight)
  - `chatgpt/o1-mini` (Math & coding reasoning)
  - `chatgpt/auto` (Automatic model selection)
- 🔄 **Multi-Account Rotation**: Pool multiple ChatGPT accounts (Free, Plus, Team, Pro). If one account hits rate limits, requests rotate seamlessly to the next.
- 🚀 **Universal Agent Compatibility**:
  - **VS Code Copilot Chat**: Native model provider in the model picker.
  - **Claude Code**: Points `ANTHROPIC_BASE_URL` to local gateway (`http://127.0.0.1:8766`).
  - **Codex CLI**: Points `OPENAI_BASE_URL` or `~/.codex/config.toml` to local gateway.

---

## Quick Start

### 1. Connect Account via Browser Login

1. Open the **ChatGPT** panel from the VS Code Activity Bar.
2. Click **Add ChatGPT Account** (`+`).
3. Your default browser opens to the OpenAI authentication page. Sign in or approve with your OpenAI/ChatGPT account.
4. Your browser redirects to the local loopback server (`localhost:1455/auth/callback`), which completes the sign-in and securely saves your account into VS Code SecretStorage.

### 2. Use in Copilot Chat

1. In the ChatGPT sidebar or Command Palette, run **ChatGPT: Set Up Copilot Chat**.
2. Open Copilot Chat (`Ctrl+Alt+I` or `Cmd+Alt+I`).
3. In the model picker, select **Manage Models → ChatGPT**, and select **GPT-4o**, **o3-mini**, or **o1**.

### 3. Claude Code & Codex CLI Integration

- **Claude Code**: Run `ChatGPT: Use Model in Claude Code` to wire your local Claude Code CLI to ChatGPT models.
- **Codex**: Run `ChatGPT: Use Model in Codex` to point Codex to the local gateway.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `chatgpt.gateway.port` | `8766` | Preferred port for local gateway. |
| `chatgpt.gateway.autoStart` | `true` | Start gateway on launch. |
| `chatgpt.rotation.strategy` | `highest-quota-first` | Rotation strategy: `highest-quota-first`, `round-robin`, or `manual`. |
| `chatgpt.quota.autoRefreshMinutes` | `10` | Frequency of background session & status checks. |
| `chatgpt.saveHistoryInChatGPTWeb` | `false` | Save API chats to chatgpt.com web sidebar. |

---

## License

MIT
