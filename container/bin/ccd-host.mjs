#!/usr/bin/env node
// Run an allow-listed command on the host, from inside the container.
//
// Used directly (`ccd-host open .`) and indirectly through the PATH shims that
// make host-only tools look locally installed.

import { runProcess } from '../lib/client.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write('usage: ccd-host <command> [args...]\n');
  process.exit(2);
}

// Forwarding the whole container environment would be actively harmful (PATH,
// HOME and friends describe the container, not the host), so only pass through
// variables the user explicitly opted into.
const forwardList = (process.env.DOCLAUDE_FORWARD_ENV || '').split(',').map((s) => s.trim()).filter(Boolean);
const env = {};
for (const key of forwardList) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}

try {
  await runProcess({ op: 'exec', cmd, args, cwd: process.cwd(), env });
} catch (err) {
  process.stderr.write(`ccd-host: ${err.message}\n`);
  process.exit(1);
}
