import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './HttpError.ts';
import {
  optionalNumber,
  optionalRecord,
  optionalString,
  requireParam,
  requireString,
} from './validation.ts';

describe('requireString', () => {
  test('returns the string when present and non-empty', () => {
    assert.equal(requireString({ name: 'agent' }, 'name'), 'agent');
  });

  test('rejects a missing field', () => {
    assert.throws(() => requireString({}, 'name'), HttpError);
  });

  test('rejects an empty/whitespace-only string', () => {
    assert.throws(() => requireString({ name: '   ' }, 'name'), HttpError);
  });

  test('rejects a non-string value', () => {
    assert.throws(() => requireString({ name: 42 }, 'name'), HttpError);
  });

  test('tolerates an undefined body', () => {
    assert.throws(() => requireString(undefined, 'name'), HttpError);
  });
});

describe('optionalString', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalString({}, 'model'), undefined);
  });

  test('returns the value when a string', () => {
    assert.equal(optionalString({ model: 'gpt' }, 'model'), 'gpt');
  });

  test('rejects a non-string value', () => {
    assert.throws(() => optionalString({ model: 1 }, 'model'), HttpError);
  });
});

describe('optionalNumber', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalNumber({}, 'maxIterations'), undefined);
  });

  test('returns the value when a finite number', () => {
    assert.equal(optionalNumber({ maxIterations: 3 }, 'maxIterations'), 3);
  });

  test('rejects a non-finite number', () => {
    assert.throws(() => optionalNumber({ maxIterations: Number.POSITIVE_INFINITY }, 'maxIterations'), HttpError);
  });

  test('rejects a non-number value', () => {
    assert.throws(() => optionalNumber({ maxIterations: '3' }, 'maxIterations'), HttpError);
  });
});

describe('optionalRecord', () => {
  test('returns undefined when absent', () => {
    assert.equal(optionalRecord({}, 'input'), undefined);
  });

  test('returns the object when present', () => {
    assert.deepEqual(optionalRecord({ input: { a: 1 } }, 'input'), { a: 1 });
  });

  test('rejects an array', () => {
    assert.throws(() => optionalRecord({ input: [1, 2] }, 'input'), HttpError);
  });

  test('rejects a primitive', () => {
    assert.throws(() => optionalRecord({ input: 'nope' }, 'input'), HttpError);
  });
});

describe('requireParam', () => {
  test('returns a single-segment param', () => {
    assert.equal(requireParam({ sessionId: 'abc' }, 'sessionId'), 'abc');
  });

  test('rejects a repeated (array) param', () => {
    assert.throws(() => requireParam({ sessionId: ['a', 'b'] }, 'sessionId'), HttpError);
  });

  test('rejects a missing param', () => {
    assert.throws(() => requireParam({}, 'sessionId'), HttpError);
  });
});
