'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStat, executing } = require('../lib/process-ledger');

test('Linux process identity parses names with parentheses and preserves start time', () => {
  const fields = ['S', '10', '20', '30', ...Array(15).fill('0'), '987654321'];
  const record = parseStat('42 (a process ) with spaces) ' + fields.join(' '));
  assert.deepEqual(record, { pid: 42, state: 'S', parent: 10, group: 20, session: 30, started: '987654321' });
  assert.equal(executing(record), true);
  assert.equal(executing({ ...record, state: 'Z' }), false);
  assert.throws(() => parseStat('invalid metadata'));
});
