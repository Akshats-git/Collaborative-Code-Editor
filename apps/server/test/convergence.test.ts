import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { TestClient, settle } from './support/y-client.js';

const app = createApp();
let baseUrl = '';

before(async () => {
  const port = await app.listen(0);
  baseUrl = `ws://127.0.0.1:${port}/doc`;
});

after(() => app.close());

test('concurrent inserts at the same position converge', async () => {
  const a = await TestClient.connect(`${baseUrl}/convergence`);
  const b = await TestClient.connect(`${baseUrl}/convergence`);
  await settle();

  // Neither client has seen the other's edit when it makes its own.
  a.insert(0, 'const answer = 42;\n');
  b.insert(0, 'function main() {}\n');
  await settle();

  assert.equal(a.text, b.text);
  assert.equal(a.text.length, 'const answer = 42;\nfunction main() {}\n'.length);

  a.close();
  b.close();
});

test('a client joining late receives the existing document', async () => {
  const a = await TestClient.connect(`${baseUrl}/late-join`);
  await settle();
  a.insert(0, 'already here');
  await settle();

  const b = await TestClient.connect(`${baseUrl}/late-join`);
  await settle();

  assert.equal(b.text, 'already here');

  a.close();
  b.close();
});

test('documents are isolated from each other', async () => {
  const a = await TestClient.connect(`${baseUrl}/room-one`);
  const b = await TestClient.connect(`${baseUrl}/room-two`);
  await settle();

  a.insert(0, 'only in room one');
  await settle();

  assert.equal(b.text, '');

  a.close();
  b.close();
});
