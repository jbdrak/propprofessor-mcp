const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function makeRepoFixture({ version = '1.0.4', changelog = '# Changelog\n\n## 1.0.4\n\n- note\n', githubRef } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pp-version-check-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ssb-for-agents', version }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return {
    dir,
    env: {
      ...process.env,
      GITHUB_REF: githubRef || ''
    }
  };
}

test('check-version-consistency passes when package version exists in changelog', () => {
  const fixture = makeRepoFixture();
  try {
    const result = spawnSync('node', [path.join(process.cwd(), 'scripts/check-version-consistency.js')], {
      cwd: fixture.dir,
      env: fixture.env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Version consistency check passed for 1\.0\.4/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('check-version-consistency fails when changelog heading is missing', () => {
  const fixture = makeRepoFixture({ changelog: '# Changelog\n\n## 1.0.3\n\n- old note\n' });
  try {
    const result = spawnSync('node', [path.join(process.cwd(), 'scripts/check-version-consistency.js')], {
      cwd: fixture.dir,
      env: fixture.env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, 'expected the script to fail');
    assert.match(result.stderr, /CHANGELOG\.md top heading is "## 1\.0\.3" but package\.json version is "1\.0\.4"/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('check-version-consistency fails when tag version does not match package version', () => {
  const fixture = makeRepoFixture({ githubRef: 'refs/tags/v1.0.5' });
  try {
    const result = spawnSync('node', [path.join(process.cwd(), 'scripts/check-version-consistency.js')], {
      cwd: fixture.dir,
      env: fixture.env,
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, 'expected the script to fail');
    assert.match(result.stderr, /Tag version v1\.0\.5 does not match package\.json version 1\.0\.4/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
