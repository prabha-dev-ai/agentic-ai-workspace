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

  test('express is confined to the HTTP layer', () => {
    const allowed = ['app.ts', 'controllers/', 'routes/'];
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
    const forbidden = ['/controllers/', '/routes/', '/core/bootstrap', '/app', '/server'];

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
