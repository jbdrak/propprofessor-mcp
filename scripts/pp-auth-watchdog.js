#!/usr/bin/env node
'use strict';

/**
 * PropProfessor Auth Watchdog — MANUAL DIAGNOSTIC
 *
 * Checks cookie session expiry. PropProfessor is manual-only: run this on
 * demand when you want a session-health readout. There is no supported
 * cron, scheduled workflow, or unattended schedule for this script.
 * - Silent when session is healthy (>7 days remaining) — no notification sent.
 * - Outputs a warning when session is expiring (≤7 days) or expired.
 * - Exit 0 always (watchdog pattern — non-zero would trigger error alerts).
 *
 * Usage:
 *   node scripts/pp-auth-watchdog.js
 */

const { resolveAuthFile, readAuthState, getCookieExpiryInfo } = require('../lib/propprofessor-api');

try {
  const authFile = resolveAuthFile();
  const authState = readAuthState(authFile);
  const info = getCookieExpiryInfo(authState);

  if (info.status === 'ok') {
    // Silent — no output = no notification
    process.exit(0);
  }

  // Output the warning readout
  const emoji = info.status === 'expired' ? '🔴' : info.status === 'critical' ? '🟡' : '🟠';
  const lines = [
    `${emoji} PropProfessor Auth: ${info.status.toUpperCase()}`,
    '',
    info.warning,
    '',
    `Session token expires: ${info.sessionExpiry || 'unknown'}`,
    `Days remaining: ${info.daysRemaining ?? 'unknown'}`,
    '',
    'To fix: pp-query login'
  ];

  console.log(lines.join('\n'));
  process.exit(0);
} catch (err) {
  // Auth file missing or unreadable
  console.log(
    `🔴 PropProfessor Auth: UNREADABLE\n\nCould not read auth file: ${err.message}\n\nTo fix: pp-query login`
  );
  process.exit(0);
}
