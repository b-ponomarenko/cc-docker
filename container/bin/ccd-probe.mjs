#!/usr/bin/env node
// Connectivity self-test, run by `doclaude self doctor` in a throwaway container.
//
// Whether a container can reach the host agent depends on the runtime (Docker
// Desktop, OrbStack, colima, Podman, plain Linux), so this is checked for real
// rather than assumed.

import fs from 'node:fs';
import { connect, agentHostCandidates, agentPort } from '../lib/client.mjs';

try {
  const { socket, ack } = await connect({ op: 'ping' }, { timeoutMs: 8000 });
  socket.destroy();
  let via = 'unknown';
  try {
    via = fs.readFileSync('/tmp/.doclaude-agent-host', 'utf8').trim();
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ ok: !!ack.ok, via, agentPid: ack.pid }));
  process.exit(ack.ok ? 0 : 1);
} catch (err) {
  console.log(
    JSON.stringify({
      ok: false,
      error: err.message,
      tried: agentHostCandidates(),
      port: (() => {
        try {
          return agentPort();
        } catch {
          return null;
        }
      })(),
    }),
  );
  process.exit(1);
}
