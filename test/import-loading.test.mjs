import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImportIntent } from '../dist/assets/core/import-intent.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('current success reports pending true then false', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const file = deferred();

  const result = intent.run(() => file.promise);
  assert.deepEqual(states, [true]);

  file.resolve('{}');
  const outcome = await result;
  assert.equal(outcome.status, 'current');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, '{}');
  assert.deepEqual(states, [true, false]);
});

test('current failure reports pending true then false', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const file = deferred();
  const failure = new Error('read failed');

  const result = intent.run(() => file.promise);
  assert.deepEqual(states, [true]);

  file.reject(failure);
  const outcome = await result;
  assert.equal(outcome.status, 'current');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, failure);
  assert.deepEqual(states, [true, false]);
});

test('invalidate clears pending for reset and scenario changes', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const file = deferred();

  const result = intent.run(() => file.promise);
  assert.deepEqual(states, [true]);

  intent.invalidate();
  assert.deepEqual(states, [true, false]);

  file.resolve('late');
  assert.deepEqual(await result, { status: 'stale' });
  assert.deepEqual(states, [true, false]);
});

test('an older overlapping read cannot clear a newer pending read', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const first = deferred();
  const second = deferred();

  const firstResult = intent.run(() => first.promise);
  const secondResult = intent.run(() => second.promise);
  assert.deepEqual(states, [true, true]);

  first.resolve('old');
  assert.deepEqual(await firstResult, { status: 'stale' });
  assert.deepEqual(states, [true, true]);

  second.resolve('new');
  const outcome = await secondResult;
  assert.equal(outcome.status, 'current');
  assert.equal(outcome.value, 'new');
  assert.deepEqual(states, [true, true, false]);
});

test('a stale rejection cannot clear a newer pending read', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const first = deferred();
  const second = deferred();

  const firstResult = intent.run(() => first.promise);
  const secondResult = intent.run(() => second.promise);
  assert.deepEqual(states, [true, true]);

  first.reject(new Error('old failed'));
  assert.deepEqual(await firstResult, { status: 'stale' });
  assert.deepEqual(states, [true, true]);

  second.resolve('new');
  const outcome = await secondResult;
  assert.equal(outcome.status, 'current');
  assert.equal(outcome.value, 'new');
  assert.deepEqual(states, [true, true, false]);
});

test('a newer invalid or canceled selection cancels the old read', async () => {
  const states = [];
  const intent = createImportIntent((pending) => states.push(pending));
  const oldFile = deferred();

  const oldResult = intent.run(() => oldFile.promise);
  assert.deepEqual(states, [true]);

  intent.invalidate();
  assert.deepEqual(states, [true, false]);

  oldFile.resolve('old');
  assert.deepEqual(await oldResult, { status: 'stale' });
  assert.deepEqual(states, [true, false]);
});

test('static integration for the loading node and app wiring (NOT browser/reader verification)', () => {
  const viewSource = readFileSync(new URL('../src/ui/view.ts', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

  assert.match(
    viewSource,
    /const\s+importStatus\s*=\s*el\(\s*['"]p['"]\s*,\s*['"]hint['"]\s*\)/,
  );
  assert.match(
    viewSource,
    /importStatus\.setAttribute\(\s*['"]role['"]\s*,\s*['"]status['"]\s*\)/,
  );
  assert.match(
    viewSource,
    /importStatus\.setAttribute\(\s*['"]aria-live['"]\s*,\s*['"]polite['"]\s*\)/,
  );
  assert.match(
    viewSource,
    /importStatus\.setAttribute\(\s*['"]aria-atomic['"]\s*,\s*['"]true['"]\s*\)/,
  );
  assert.match(viewSource, /importStatus\.hidden\s*=\s*true/);
  assert.match(viewSource, /readonly\s+importStatus\s*:\s*HTMLParagraphElement\s*;/);
  assert.match(viewSource, /\bimportStatus\s*,/);

  assert.match(appSource, /createImportIntent\(\s*\(pending\)\s*=>/);
  assert.match(appSource, /view\.importStatus\.hidden\s*=\s*!pending/);
  assert.match(appSource, /view\.importStatus\.textContent\s*=/);
  assert.match(appSource, /Reading the local JSON/);
});
