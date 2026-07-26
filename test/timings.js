'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_DIR = path.join(__dirname);
const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
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

  const testMatch = (result.stderr || '').match(/# tests (\d+)/);
  const testCount = testMatch ? parseInt(testMatch[1], 10) : 0;

  totalDuration += duration;
  totalTests += testCount;

  const name = file.padEnd(42);
  const durStr = String(duration).padStart(12);
  const testStr = String(testCount).padStart(7);
  console.log(`${name}  ${durStr} ${testStr}`);
}

console.log('─'.repeat(75));
console.log(`TOTAL${' '.repeat(38)}${String(totalDuration).padStart(12)} ${String(totalTests).padStart(7)}`);
