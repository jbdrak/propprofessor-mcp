const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PP_BIN = path.resolve(__dirname, '..', 'bin', 'pp');

test('pp help prints usage', () => {
  const result = spawnSync(process.execPath, [PP_BIN, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /pp — PropProfessor CLI/);
  assert.match(result.stdout, /today/);
});

test('pp with no args prints help', () => {
  const result = spawnSync(process.execPath, [PP_BIN], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pp <command>/);
});

test('pp unknown command passes through to pp-query', () => {
  // 'list' is a real pp-query command — should work via pass-through.
  const result = spawnSync(process.execPath, [PP_BIN, 'list'], { encoding: 'utf8' });
  // Don't assert exit code (list is a real command, exits 0; the point is no crash)
  assert.ok(result.stdout.length > 0, 'pp list should produce output');
});
