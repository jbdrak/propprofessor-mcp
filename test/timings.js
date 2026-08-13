'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function parseTapTestCount(output) {
  const match = String(output || '').match(/(?:ℹ\s+tests|#\s+tests)\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function summarizeChildResult(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.error) return { ok: false, message: output || result.error.message };
  if (result.signal) return { ok: false, message: output || `child terminated by ${result.signal}` };
  if (result.status !== 0) return { ok: false, message: output || `child exited with status ${result.status}` };
  const testCount = parseTapTestCount(output);
  if (!Number.isInteger(testCount) || testCount <= 0) {
    return { ok: false, message: `${output}\nchild reported no positive test count` };
  }
  return { ok: true, message: output };
}

if (require.main === module) {
  const TEST_DIR = path.join(__dirname);
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename))
    .sort();

  console.log('File                                        Duration (ms)  Tests');
  console.log('─'.repeat(75));

  let totalDuration = 0;
  let totalTests = 0;

  for (const file of files) {
    const filePath = path.join(TEST_DIR, file);
    const start = Date.now();
    const result = spawnSync(process.execPath, ['--test', filePath], {
      timeout: 120000,
      encoding: 'utf8'
    });
    const duration = Date.now() - start;

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const child = summarizeChildResult(result);
    const testCount = parseTapTestCount(output);

    totalDuration += duration;
    totalTests += testCount;

    const name = file.padEnd(42);
    const durStr = String(duration).padStart(12);
    const testStr = String(testCount).padStart(7);
    console.log(`${name}  ${durStr} ${testStr}`);
    if (!child.ok) {
      console.error(`FAILED ${file}:\n${child.message}`);
      process.exitCode = 1;
    }
  }

  console.log('─'.repeat(75));
  console.log(`TOTAL${' '.repeat(38)}${String(totalDuration).padStart(12)} ${String(totalTests).padStart(7)}`);
}

module.exports = { parseTapTestCount, summarizeChildResult };
