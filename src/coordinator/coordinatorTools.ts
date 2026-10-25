import * as vscode from 'vscode';
import { CoordinatorService } from './coordinatorService';
import { Logger } from '../utils/logger';

export function registerCoordinatorTools(
  context: vscode.ExtensionContext,
  coordinator: CoordinatorService,
): void {
  // Only register if vscode.lm.registerTool is supported in this VS Code build
  if (typeof (vscode.lm as any)?.registerTool !== 'function') {
    Logger.debug('vscode.lm.registerTool not available in current VS Code runtime.');
    return;
  }

  // 1. Tool: chatgpt_listAvailableModels
  context.subscriptions.push(
    (vscode.lm as any).registerTool('chatgpt_listAvailableModels', {
      async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<any>,
        _token: vscode.CancellationToken,
      ) {
        const models = await coordinator.listAvailableModels();
        const formatted = models.map((m) => ({
          id: m.id,
          vendor: m.vendor,
          name: m.name,
          family: m.family,
          maxInputTokens: m.maxInputTokens,
        }));
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(formatted, null, 2)),
        ]);
      },
    }),
  );

  // 2. Tool: chatgpt_delegateTask
  context.subscriptions.push(
    (vscode.lm as any).registerTool('chatgpt_delegateTask', {
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
          targetModelId: string;
          taskTitle: string;
          taskDescription: string;
          priority?: 'low' | 'normal' | 'high';
        }>,
        token: vscode.CancellationToken,
      ) {
        const { targetModelId, taskTitle, taskDescription, priority } = options.input;
        if (!targetModelId || !taskTitle || !taskDescription) {
          throw new Error('targetModelId, taskTitle, and taskDescription are all required.');
        }

        const task = coordinator.createTask(taskTitle, taskDescription, targetModelId, priority);
        const { result } = await coordinator.delegateTask(task.id, targetModelId, undefined, token);

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Task "${taskTitle}" (ID: ${task.id}) executed by model ${targetModelId}:\n\n${result}`,
          ),
        ]);
      },
    }),
  );

  // 3. Tool: chatgpt_coordinatorCreateTask
  context.subscriptions.push(
    (vscode.lm as any).registerTool('chatgpt_coordinatorCreateTask', {
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
          title: string;
          description: string;
          assignee?: string;
          priority?: 'low' | 'normal' | 'high';
        }>,
        _token: vscode.CancellationToken,
      ) {
        const { title, description, assignee, priority } = options.input;
        const task = coordinator.createTask(title, description, assignee, priority);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(task, null, 2)),
        ]);
      },
    }),
  );

  // 4. Tool: chatgpt_coordinatorListTasks
  context.subscriptions.push(
    (vscode.lm as any).registerTool('chatgpt_coordinatorListTasks', {
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
          status?: 'open' | 'claimed' | 'blocked' | 'done';
        }>,
        _token: vscode.CancellationToken,
      ) {
        const status = options.input?.status;
        const tasks = coordinator.listTasks(status);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(tasks, null, 2)),
        ]);
      },
    }),
  );

  // 5. Tool: chatgpt_coordinatorUpdateTask
  context.subscriptions.push(
    (vscode.lm as any).registerTool('chatgpt_coordinatorUpdateTask', {
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
          taskId: string;
          status: 'open' | 'claimed' | 'blocked' | 'done';
          agent: string;
          result?: string;
        }>,
        _token: vscode.CancellationToken,
      ) {
        const { taskId, status, agent, result } = options.input;
        const task = coordinator.updateTask(taskId, status, agent, result);
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(task, null, 2)),
        ]);
      },
    }),
  );

  Logger.info('Registered ChatGPT Maestro coordinator language model tools.');
}
