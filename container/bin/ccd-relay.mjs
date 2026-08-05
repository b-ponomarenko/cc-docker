#!/usr/bin/env node
// Long-lived reverse tunnel, started by the entrypoint before Claude Code.
//
// It owns the session's channel to the host agent; the host uses it to push
// inbound connections (OAuth callbacks, forwarded dev-server ports) into the
// container. Reconnects on drop so a restarted agent does not break the session.

import { runRelay } from '../lib/client.mjs';

const forward = (process.env.DOCLAUDE_FORWARD_PORTS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

let attempt = 0;
for (;;) {
  try {
    await runRelay({ forward });
    attempt = 0; // clean disconnect: reset the backoff
  } catch (err) {
    if (process.env.DOCLAUDE_DEBUG === '1') {
      process.stderr.write(`ccd-relay: ${err.message}\n`);
    }
    attempt += 1;
  }
  const delay = Math.min(500 * 2 ** Math.min(attempt, 5), 10_000);
  await new Promise((r) => setTimeout(r, delay));
}
