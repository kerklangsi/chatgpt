import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

const stubPath = path.join(__dirname, 'stubs', 'vscode.js');
const resolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...args: unknown[]) {
  return request === 'vscode' ? stubPath : resolveFilename.call(this, request, ...args);
};

import { decodeJwtPayload, extractSubscriptionTier } from '../auth/sessionAuth';
import { solveProofOfWork } from '../upstream/sentinel';

test('sessionAuth: decodeJwtPayload and extract subscription tier', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user-12345',
      email: 'test@example.com',
      'https://api.openai.com/auth': {
        plan_type: 'plus',
      },
    }),
  ).toString('base64');
  const fakeJwt = `${header}.${payload}.signature`;

  const decoded = decodeJwtPayload(fakeJwt);
  assert.ok(decoded);
  assert.equal(decoded.sub, 'user-12345');
  assert.equal(decoded.email, 'test@example.com');

  const tier = extractSubscriptionTier(decoded);
  assert.equal(tier, 'plus');
});

test('sentinel: solveProofOfWork completes correctly', () => {
  // A test seed with very easy difficulty
  const seed = 'test-seed-xyz';
  const difficulty = 'ffff';
  const solved = solveProofOfWork(seed, difficulty);
  assert.ok(solved);
  assert.ok(typeof solved === 'string');
});
