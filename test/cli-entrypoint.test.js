'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');

const projectRoot = path.join(__dirname, '..');
const ppPath = path.join(projectRoot, 'bin', 'pp');

describe('pp CLI entrypoint', () => {
  it('prints help through the bin/pp wrapper', () => {
    const result = execFileSync(process.execPath, [ppPath, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8'
    });

    assert.match(result, /pp — PropProfessor CLI/);
    assert.match(result, /Usage: pp <command> \[args\.\.\.\]/);
    assert.notEqual(result.trim(), '');
  });
});
