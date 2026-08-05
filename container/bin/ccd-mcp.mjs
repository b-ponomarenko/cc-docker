#!/usr/bin/env node
// Stdio shim for a host-resident MCP server.
//
// Claude Code inside the container spawns `ccd-mcp <name>` exactly as it would
// spawn the real server. We forward the JSON-RPC stream to the host agent,
// which runs the actual server binary in the user's real environment.

import { runProcess } from '../lib/client.mjs';

const name = process.argv[2];
if (!name) {
  process.stderr.write('usage: ccd-mcp <server-name>\n');
  process.exit(2);
}

try {
  await runProcess({ op: 'mcp', name, cwd: process.cwd() });
} catch (err) {
  process.stderr.write(`ccd-mcp: ${err.message}\n`);
  process.exit(1);
}
