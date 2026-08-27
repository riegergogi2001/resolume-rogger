'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { relaunchOptions } = require('../src/main/relaunch.js');

test('a portable build relaunches the real exe, not the unpacked temp copy', () => {
  assert.deepEqual(relaunchOptions({ PORTABLE_EXECUTABLE_FILE: 'D:\\ROG\\ROGGER-2.2.8.exe' }),
    { execPath: 'D:\\ROG\\ROGGER-2.2.8.exe' });
});

test('development and non-portable builds relaunch the default way', () => {
  assert.equal(relaunchOptions({}), undefined);
  assert.equal(relaunchOptions({ PORTABLE_EXECUTABLE_FILE: '' }), undefined);
});
