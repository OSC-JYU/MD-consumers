// elg adapter: how a service answer becomes outputs and callback messages. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serviceOutputs, callbackMessage } from '../src/adapters/elg.mjs';

test('a files entry with ref_file_rid is a reference output without a tmp file', () => {
  const answer = { response: { files: [{ ref_file_rid: '#1:1', label: 'rotate', extension: 'jpg', type: 'image' }] } };
  const outputs = serviceOutputs(answer, {});
  assert.deepEqual(outputs, [{ reference: '#1:1', label: 'rotate', extension: 'jpg', type: 'image' }]);
});

test('callback message of a reference output names the referenced file', () => {
  const msg = { file: { '@rid': '#2:1', type: 'osd.json', extension: 'json', label: 'x.osd.json', project_rid: '#3:1' }, process: { '@rid': '#4:1' } };
  const output = { reference: '#1:1', label: 'rotate', extension: 'jpg', type: 'image' };
  const message = callbackMessage(msg, {}, output, 0, 1)
  assert.equal(message.ref_file_rid, '#1:1');
  assert.equal(message.file.type, 'image');
  assert.equal(message.file.extension, 'jpg');
  assert.equal(message.file.source['@rid'], '#2:1');
});

test('a normal output carries no reference', () => {
  const msg = { file: { '@rid': '#2:1', type: 'image', extension: 'jpg', label: 'a.jpg' } };
  const message = callbackMessage(msg, {}, { tmpName: 'x.jpg', label: 'x', extension: 'jpg', type: 'image' }, 0, 1);
  assert.equal(message.ref_file_rid, undefined);
});
