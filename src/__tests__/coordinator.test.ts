import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

import { CoordinatorService } from '../coordinator/coordinatorService';

test('coordinator: create, list, claim, update tasks and send messages', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-test-'));
  const testFile = path.join(tmpDir, '.agent-coordinator', 'tasks.json');

  const mockContext = {
    globalStorageUri: { fsPath: tmpDir },
  } as any;

  const service = new CoordinatorService(mockContext);
  service.setStateFile(testFile);

  // 1. Create task
  const task = service.createTask(
    'Implement auth helper',
    'Write the auth helper in src/auth.ts',
    'worker-1',
    'high',
  );
  assert.ok(task.id.startsWith('task-'));
  assert.equal(task.title, 'Implement auth helper');
  assert.equal(task.status, 'open');
  assert.equal(task.priority, 'high');
  assert.equal(task.assignee, 'worker-1');

  // 2. List tasks
  const openTasks = service.listTasks('open');
  assert.equal(openTasks.length, 1);
  assert.equal(openTasks[0].id, task.id);

  // 3. Claim task
  const claimed = service.claimTask(task.id, 'worker-1');
  assert.equal(claimed.status, 'claimed');

  // 4. Send message
  const msg = service.sendMessage(task.id, 'lead-agent', 'Please focus on unit tests too');
  assert.equal(msg.message, 'Please focus on unit tests too');
  const msgs = service.getMessages(task.id);
  assert.equal(msgs.length, 1);

  // 5. Update task to done with result
  const done = service.updateTask(task.id, 'done', 'worker-1', 'Auth helper implemented successfully.');
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Auth helper implemented successfully.');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
