import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Architectural fitness functions: the rules the AAI-014C audit verified,
// as executable tests. If a change breaks a layering or ownership rule,
// it fails here — in CI, not in a code review three months later.

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

interface SourceFile {
  /** Path relative to src/, with forward slashes. */
  path: string;
  content: string;
}

function collectSourceFiles(dir: string): SourceFile[] {
  const files: SourceFile[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push({
        path: relative(SRC_DIR, fullPath).replaceAll('\\', '/'),
        content: readFileSync(fullPath, 'utf8'),
      });
    }
  }

  return files;
}

const sources = collectSourceFiles(SRC_DIR);
const nonTestSources = sources.filter((file) => !file.path.endsWith('.test.ts'));

describe('ownership rules', () => {
  test('the OpenAI client is constructed only in the composition root', () => {
    const constructors = nonTestSources.filter((file) =>
      file.content.includes('new OpenAI('),
    );
    assert.deepEqual(
      constructors.map((file) => file.path),
      ['core/bootstrap.ts'],
      'new OpenAI(...) must appear exactly once, in core/bootstrap.ts',
    );
  });

  test('only the composition root imports openai as a value', () => {
    const valueImports = nonTestSources.filter((file) =>
      /^import (?!type ).*from 'openai'/m.test(file.content),
    );
    assert.deepEqual(
      valueImports.map((file) => file.path),
      ['core/bootstrap.ts'],
      'all other files must use "import type" for openai',
    );
  });

  test('process.env is read only by config/env.ts', () => {
    const readers = nonTestSources.filter(
      (file) => file.content.includes('process.env') && file.path !== 'config/env.ts',
    );
    assert.deepEqual(
      readers.map((file) => file.path),
      [],
      'environment access must stay behind the config module',
    );
  });

  // AAI-036: the same single-construction-site discipline as the OpenAI
  // client above, extended to the two new external clients the
  // persistent-storage providers depend on. Every other module talks to
  // PgClient/RedisClient (the narrow interfaces in core/database and
  // core/caching), never the concrete packages.
  test('the Postgres client is constructed only in the composition root', () => {
    const constructors = nonTestSources.filter((file) => file.content.includes('new Pool('));
    assert.deepEqual(
      constructors.map((file) => file.path),
      ['core/bootstrap.ts'],
      'new Pool(...) must appear exactly once, in core/bootstrap.ts',
    );
  });

  test('only the composition root imports pg as a value', () => {
    const valueImports = nonTestSources.filter((file) =>
      /^import (?!type ).*from 'pg'/m.test(file.content),
    );
    assert.deepEqual(
      valueImports.map((file) => file.path),
      ['core/bootstrap.ts'],
      'all other files must use "import type" for pg, or depend on PgClient instead',
    );
  });

  test('the Redis client is constructed only in the composition root', () => {
    const constructors = nonTestSources.filter((file) =>
      file.content.includes('createClient('),
    );
    assert.deepEqual(
      constructors.map((file) => file.path),
      ['core/bootstrap.ts'],
      'createClient(...) must appear exactly once, in core/bootstrap.ts',
    );
  });

  test('only the composition root imports redis as a value', () => {
    const valueImports = nonTestSources.filter((file) =>
      /^import (?!type ).*from 'redis'/m.test(file.content),
    );
    assert.deepEqual(
      valueImports.map((file) => file.path),
      ['core/bootstrap.ts'],
      'all other files must use "import type" for redis, or depend on RedisClient instead',
    );
  });

  // AAI-037: the WebSocket transport is inbound server infrastructure, the
  // same category as Express itself — not an outbound network client like
  // OpenAI/Postgres/Redis — so it is wired up in the HTTP layer (the
  // gateway module), not core/bootstrap.ts. Same single-construction-site
  // discipline regardless: exactly one place stands up the upgrade
  // handler for the whole process.
  test('the WebSocket server is constructed only in the chat gateway', () => {
    const constructors = nonTestSources.filter((file) =>
      file.content.includes('new WebSocketServer('),
    );
    assert.deepEqual(
      constructors.map((file) => file.path),
      ['websocket/ChatWebSocketGateway.ts'],
      'new WebSocketServer(...) must appear exactly once, in websocket/ChatWebSocketGateway.ts',
    );
  });

  test('only the chat gateway imports ws as a value', () => {
    const valueImports = nonTestSources.filter((file) =>
      /^import (?!type ).*from 'ws'/m.test(file.content),
    );
    assert.deepEqual(
      valueImports.map((file) => file.path),
      ['websocket/ChatWebSocketGateway.ts'],
      'all other files must use "import type" for ws',
    );
  });
});

describe('layering rules', () => {
  test('the container is pure: imports nothing outside core/container', () => {
    const containerFiles = nonTestSources.filter((file) =>
      file.path.startsWith('core/container/'),
    );
    assert.ok(containerFiles.length >= 4, 'container files must exist');

    for (const file of containerFiles) {
      const specifiers = [...file.content.matchAll(/from '([^']+)'/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        assert.ok(
          specifier?.startsWith('./'),
          `${file.path} imports "${specifier}" — the container must stay dependency-free`,
        );
      }
    }
  });

  // AAI-037: middleware/ joins app.ts/controllers/routes/ as HTTP-layer —
  // Express types (Request/Response/NextFunction/RequestHandler) are the
  // whole point of a middleware module, the same way they're the point of
  // a controller.
  test('express is confined to the HTTP layer', () => {
    const allowed = ['app.ts', 'controllers/', 'routes/', 'middleware/'];
    const violations = nonTestSources.filter(
      (file) =>
        file.content.includes("from 'express'") &&
        !allowed.some((prefix) => file.path.startsWith(prefix)),
    );
    assert.deepEqual(violations.map((file) => file.path), []);
  });

  test('domain modules never import upward into HTTP or the composition root', () => {
    const domainDirs = [
      'agents/', 'executor/', 'knowledge/', 'memory/', 'planner/',
      'prompts/', 'services/', 'tools/', 'types/',
    ];
    const forbidden = ['/controllers/', '/routes/', '/middleware/', '/core/bootstrap', '/app', '/server', '/websocket/'];

    for (const file of nonTestSources) {
      if (!domainDirs.some((dir) => file.path.startsWith(dir))) continue;

      const specifiers = [...file.content.matchAll(/from '([^']+)'/g)].map(
        (match) => match[1] ?? '',
      );
      for (const specifier of specifiers) {
        assert.ok(
          !forbidden.some((banned) => specifier.includes(banned)),
          `${file.path} imports "${specifier}" — domain code must not depend on HTTP or bootstrap`,
        );
      }
    }
  });
});
