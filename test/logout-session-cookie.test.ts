/**
 * POST /logout with a session cookie that is not a session.
 *
 * The route read the cookie by hand and ran decodeURIComponent on it, so
 * `Cookie: aj_session=%E0%A4%A` - a malformed escape - threw a URIError out
 * of the route and answered 500 where every token that matches no session
 * answers the redirect home. It now reads the cookie the way the middleware
 * does.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://agenticjobs:agenticjobs@localhost:5432/agenticjobs';

let app: Hono<never> | null = null;
let pool: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>;
} | null = null;
let closePool: (() => Promise<void>) | null = null;
let reason = '';
let ready = false;

try {
  const db = await import('../dist/db/pool.js');
  const { migrate } = await import('../dist/db/migrate.js');
  const { createApp } = await import('../dist/server/app.js');
  const { loadConfig } = await import('../dist/config.js');
  const created = db.getPool(DATABASE_URL);
  await created.query('select 1');
  await migrate(created);
  pool = created as never;
  closePool = db.closePool;
  const config = loadConfig({
    ...process.env,
    DATABASE_URL,
    PUBLIC_URL: 'http://board.test',
    SECRET: 'test-secret',
  });
  app = createApp(created, config, { send: async () => true }) as never;
  ready = true;
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
}

after(async () => {
  if (closePool !== null) await closePool();
});

async function logout(cookie: string): Promise<Response> {
  if (app === null) throw new Error('no app');
  return app.fetch(
    new Request('http://board.test/logout', { method: 'POST', headers: { cookie } }),
  );
}

describe(
  'logout with a broken cookie',
  { skip: ready ? false : `no database: ${reason || 'setup failed'}` },
  () => {
    test('a malformed escape redirects instead of throwing', async () => {
      const res = await logout('aj_session=%E0%A4%A');
      assert.equal(res.status, 303);
    });

    test('a NUL byte redirects instead of reaching a parameter', async () => {
      const res = await logout('aj_session=%00');
      assert.equal(res.status, 303);
    });

    test('a real session is still revoked', async () => {
      const { createSession, ensureUser, viewerFromToken } = await import('../dist/core/auth.js');
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const user = await ensureUser(pool as never, `logout+${stamp}@example.com`, 'Logout Tester');
      const token = await createSession(pool as never, user.id, { label: 'test' });
      assert.notEqual(await viewerFromToken(pool as never, token), null);

      const res = await logout(`aj_session=${token}`);
      assert.equal(res.status, 303);
      assert.equal(await viewerFromToken(pool as never, token), null);
    });
  },
);
