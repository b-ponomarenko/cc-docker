#!/usr/bin/env node
// Connectivity self-test, run by `doclaude self doctor` in a throwaway container.
//
// Whether a container can reach the host agent depends on the runtime (Docker
// Desktop, OrbStack, colima, Podman, plain Linux), so this is checked for real
// rather than assumed.

import fs from 'node:fs';
import { connect, agentHostCandidates, agentPort } from '../lib/client.mjs';

/**
 * Does outbound TLS actually verify from in here? On a network that intercepts
 * TLS this is the first thing that breaks, and the resulting errors surface far
 * away from the cause.
 */
async function checkTls() {
  const url = process.env.DOCLAUDE_TLS_PROBE_URL || 'https://api.anthropic.com/v1/models';
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    // Any HTTP status means the TLS handshake succeeded, which is the question.
    return { ok: true, status: response.status };
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    return { ok: false, error: String(cause) };
  }
}

try {
  const { socket, ack } = await connect({ op: 'ping' }, { timeoutMs: 8000 });
  socket.destroy();
  let via = 'unknown';
  try {
    via = fs.readFileSync('/tmp/.doclaude-agent-host', 'utf8').trim();
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ ok: !!ack.ok, via, agentPid: ack.pid, tls: await checkTls() }));
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
