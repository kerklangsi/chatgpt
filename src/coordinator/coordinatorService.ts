import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvailableModelInfo, CoordinatorMessage, CoordinatorTask } from '../accounts/types';
import { Logger } from '../utils/logger';

interface CoordinatorState {
  tasks: CoordinatorTask[];
  messages: CoordinatorMessage[];
}

export class CoordinatorService {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private stateFileOverride?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Resolves the path to .agent-coordinator/tasks.json.
   * Checks workspace root, or falls back to extension global storage.
   */
  resolveStatePath(): string {
    if (this.stateFileOverride) {
      return this.stateFileOverride;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      for (const f of folders) {
        const candidate = path.join(f.uri.fsPath, '.agent-coordinator', 'tasks.json');
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      // Check parent of first workspace folder
      const parentCandidate = path.join(folders[0].uri.fsPath, '..', '.agent-coordinator', 'tasks.json');
      if (fs.existsSync(parentCandidate)) {
        return parentCandidate;
      }

      // Default to first workspace folder's .agent-coordinator/tasks.json
      const defaultPath = path.join(folders[0].uri.fsPath, '.agent-coordinator', 'tasks.json');
      return defaultPath;
    }

    // Fallback: extension storage path
    return path.join(this.context.globalStorageUri.fsPath, '.agent-coordinator', 'tasks.json');
  }

  setStateFile(file: string): void {
    this.stateFileOverride = file;
    this.onDidChangeEmitter.fire();
  }

  private loadState(): CoordinatorState {
    const file = this.resolveStatePath();
    if (!fs.existsSync(file)) {
      return { tasks: [], messages: [] };
    }
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    } catch (err: any) {
      Logger.warn(`Failed to read coordinator state: ${err.message}`);
      return { tasks: [], messages: [] };
    }
  }

  private saveState(state: CoordinatorState): void {
    const file = this.resolveStatePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    this.onDidChangeEmitter.fire();
  }

  // ── Task Management ────────────────────────────────────────────────────────

  listTasks(status?: 'open' | 'claimed' | 'blocked' | 'done'): CoordinatorTask[] {
    const state = this.loadState();
    if (!status) return state.tasks;
    return state.tasks.filter((t) => t.status === status);
  }

  getTask(taskId: string): CoordinatorTask | undefined {
    const state = this.loadState();
    return state.tasks.find((t) => t.id === taskId);
  }

  createTask(
    title: string,
    description: string,
    assignee?: string,
    priority: 'low' | 'normal' | 'high' = 'normal',
  ): CoordinatorTask {
    const state = this.loadState();
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const task: CoordinatorTask = {
      id,
      title: title.trim(),
      description: description.trim(),
      assignee: assignee?.trim() || null,
      priority,
      status: 'open',
      result: '',
      created_at: now,
      updated_at: now,
    };

    state.tasks.push(task);
    this.saveState(state);
    Logger.info(`Created coordinator task: ${task.id} (${task.title})`);
    return task;
  }

  claimTask(taskId: string, agent: string): CoordinatorTask {
    const state = this.loadState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.status !== 'open' && task.assignee !== agent) {
      throw new Error(`Task ${taskId} is already ${task.status} by ${task.assignee || 'another agent'}`);
    }

    task.status = 'claimed';
    task.assignee = agent.trim();
    task.updated_at = new Date().toISOString();
    this.saveState(state);
    return task;
  }

  updateTask(
    taskId: string,
    status: 'open' | 'claimed' | 'blocked' | 'done',
    agent: string,
    result?: string,
  ): CoordinatorTask {
    const state = this.loadState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = status;
    task.assignee = agent.trim();
    if (result !== undefined) {
      task.result = result.trim();
    }
    task.updated_at = new Date().toISOString();
    this.saveState(state);
    Logger.info(`Updated coordinator task ${task.id} -> ${task.status}`);
    return task;
  }

  sendMessage(taskId: string, fromAgent: string, message: string): CoordinatorMessage {
    const state = this.loadState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const msg: CoordinatorMessage = {
      task_id: taskId,
      from_agent: fromAgent.trim(),
      message: message.trim(),
      created_at: new Date().toISOString(),
    };
    state.messages.push(msg);
    this.saveState(state);
    return msg;
  }

  getMessages(taskId: string): CoordinatorMessage[] {
    const state = this.loadState();
    return state.messages.filter((m) => m.task_id === taskId);
  }

  // ── Available Models Discovery ─────────────────────────────────────────────

  /**
   * Discovers all language models registered in VS Code (Antigravity, OpenRouter, Copilot, etc.)
   */
  async listAvailableModels(): Promise<AvailableModelInfo[]> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({
        id: m.id,
        vendor: m.vendor,
        family: m.family,
        name: m.name,
        maxInputTokens: m.maxInputTokens,
      }));
    } catch (err: any) {
      Logger.warn(`Failed to list available chat models: ${err.message}`);
      return [];
    }
  }

  // ── Delegation Execution ───────────────────────────────────────────────────

  /**
   * Delegates a task to another available model in VS Code, runs it, and records the result.
   */
  async delegateTask(
    taskId: string,
    targetModelId: string,
    extraInstructions?: string,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<{ task: CoordinatorTask; result: string }> {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Coordinator task not found: ${taskId}`);
    }

    this.claimTask(taskId, targetModelId);

    Logger.info(`Delegating task ${taskId} ("${task.title}") to model "${targetModelId}"…`);

    // Find the target model
    const available = await vscode.lm.selectChatModels();
    let target = available.find((m) => m.id === targetModelId);

    // Fallback search by vendor/family or substring
    if (!target) {
      const query = targetModelId.toLowerCase();
      target = available.find(
        (m) =>
          m.id.toLowerCase().includes(query) ||
          m.name.toLowerCase().includes(query) ||
          m.family.toLowerCase().includes(query),
      );
    }

    if (!target) {
      const availableList = available.map((m) => `${m.id} (${m.name})`).join('\n  - ');
      const msg = `Target model '${targetModelId}' not found. Available models:\n  - ${availableList}`;
      this.updateTask(taskId, 'blocked', targetModelId, msg);
      throw new Error(msg);
    }

    // Build the prompt for the target model
    const promptParts = [
      `# Task: ${task.title}`,
      '',
      task.description,
    ];

    if (extraInstructions) {
      promptParts.push('', '## Additional Instructions', extraInstructions);
    }

    promptParts.push(
      '',
      'Please perform the assigned task completely. Provide the code changes or solution directly.',
    );

    const fullPrompt = promptParts.join('\n');

    let accumulatedResult = '';
    try {
      const response = await target.sendRequest(
        [vscode.LanguageModelChatMessage.User(fullPrompt)],
        {},
        cancellationToken,
      );

      for await (const chunk of response.text) {
        accumulatedResult += chunk;
      }

      const updated = this.updateTask(taskId, 'done', target.id, accumulatedResult);
      Logger.info(`Task ${taskId} completed successfully by ${target.id}`);
      return { task: updated, result: accumulatedResult };
    } catch (err: any) {
      Logger.error(`Delegation to model ${target.id} failed`, err);
      this.updateTask(
        taskId,
        'blocked',
        target.id,
        `Execution error on model ${target.id}: ${err.message}`,
      );
      throw err;
    }
  }
}
