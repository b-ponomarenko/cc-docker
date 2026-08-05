#!/usr/bin/env node
// Browser opener. Installed on PATH as `xdg-open`, `sensible-browser`,
// `www-browser` and `ccd-open`.
//
// Beyond opening the URL on the host, this is the half of the OAuth story that
// makes subscription login work: the host agent inspects the URL, notices the
// `redirect_uri=http://localhost:<random-port>/callback` that Claude Code's
// login listener just bound *inside the container*, and reverse-tunnels that
// exact port so the browser's redirect lands on the right listener.

import { connect, sessionId } from '../lib/client.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('-'));

if (!url) {
  process.stderr.write('usage: ccd-open <url>\n');
  process.exit(2);
}

try {
  const { socket, ack } = await connect({ op: 'open', url, session: sessionId() });
  socket.end();
  if (process.env.DOCLAUDE_DEBUG === '1') {
    process.stderr.write(`ccd-open: ${JSON.stringify(ack)}\n`);
  }
  if (ack.requestedPorts?.length && !ack.tunnelled?.length) {
    process.stderr.write(
      `\ncc-docker: could not reverse-tunnel port ${ack.requestedPorts.join(', ')} to the host.\n` +
        `If the browser cannot complete the redirect, choose the manual code entry option.\n\n`,
    );
  }
  process.exit(0);
} catch (err) {
  // Never swallow the URL: a broken agent must not mean an unfinishable login.
  process.stderr.write(
    `\ncc-docker: could not reach the host agent (${err.message}).\n` +
      `Open this URL manually in your browser:\n\n  ${url}\n\n`,
  );
  process.exit(1);
}
