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
import { buildAuthUrl, generatePkce, OPENAI_OAUTH_CLIENT_ID } from '../auth/oauthClient';
import { CANDIDATE_PORTS, startLoopbackServer } from '../auth/loopbackServer';
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

test('sessionAuth: reads ChatGPT plan type from the namespaced auth claim', () => {
  assert.equal(
    extractSubscriptionTier({
      'https://api.openai.com/auth': { chatgpt_plan_type: 'PLUS' },
    }),
    'plus',
  );
});

test('oauthClient: generates valid PKCE pair and authorization URL', () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier && verifier.length >= 43);
  assert.ok(challenge && challenge.length >= 43);

  const authUrl = buildAuthUrl('http://localhost:1455/auth/callback', 'state-123', challenge);
  const parsed = new URL(authUrl);
  assert.equal(parsed.origin, 'https://auth.openai.com');
  assert.equal(parsed.pathname, '/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), OPENAI_OAUTH_CLIENT_ID);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge'), challenge);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), 'state-123');
});

test('loopbackServer: starts on candidate port and disposes cleanly', async () => {
  const session = await startLoopbackServer('test-state-xyz');
  assert.ok(session.redirectUri.includes('/auth/callback'));
  const port = parseInt(new URL(session.redirectUri).port, 10);
  assert.ok(CANDIDATE_PORTS.includes(port));
  session.dispose();
});

test('sentinel: solveProofOfWork completes correctly', () => {
  // A test seed with very easy difficulty
  const seed = 'test-seed-xyz';
  const difficulty = 'ffff';
  const solved = solveProofOfWork(seed, difficulty);
  assert.ok(solved);
  assert.ok(typeof solved === 'string');
});
