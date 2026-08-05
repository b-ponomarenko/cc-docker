// In-container client for the cc-docker host agent.
//
// Everything the container needs from the host goes through here: MCP servers,
// host command execution, browser opening and the reverse TCP tunnel.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readHello, FrameReader, writeFrame, b64, unb64 } from '../shared/proto.mjs';

/**
 * Container runtimes disagree about how the host is addressed:
 * Docker Desktop and OrbStack publish `host.docker.internal`, Podman prefers
 * `host.containers.internal`, and a plain Linux bridge only offers the default
 * gateway. Rather than pick one, try them in order and remember what worked.
 */
export function agentHostCandidates() {
  const explicit = (process.env.DOCLAUDE_AGENT_HOST || '').split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = [...explicit, 'host.docker.internal', 'gateway.docker.internal', 'host.containers.internal'];
  const gateway = defaultGateway();
  if (gateway) candidates.push(gateway);
  return [...new Set(candidates)];
}

function defaultGateway() {
  // /proc/net/route holds the gateway as a little-endian hex word.
  try {
    const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 2 && cols[1] === '00000000' && cols[2] !== '00000000') {
        const hex = cols[2];
        const octets = [];
        for (let i = 6; i >= 0; i -= 2) octets.push(parseInt(hex.slice(i, i + 2), 16));
        return octets.join('.');
      }
    }
  } catch {
    /* not Linux, or no route table */
  }
  return null;
}

export function agentPort() {
  const port = Number(process.env.DOCLAUDE_AGENT_PORT || 0);
  if (!port) throw new Error('DOCLAUDE_AGENT_PORT is not set — is this running under doclaude?');
  return port;
}

export function agentToken() {
  const file =
    process.env.DOCLAUDE_TOKEN_FILE ||
    path.join(process.env.DOCLAUDE_DIR || path.join(os.homedir(), '.cc-docker'), 'agent.token');
  return fs.readFileSync(file, 'utf8').trim();
}

export function sessionId() {
  return process.env.DOCLAUDE_SESSION || 'default';
}

const CACHE_FILE = '/tmp/.doclaude-agent-host';

function dial(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`${host}:${port}: ${err.message}`));
    });
  });
}

/** Opens a connection and completes the handshake. Resolves with the socket. */
export async function connect(hello, { timeoutMs = 15000 } = {}) {
  const port = agentPort();

  // A previously successful host short-circuits the probe, which matters: every
  // MCP server launch goes through here.
  let cached = null;
  try {
    cached = fs.readFileSync(CACHE_FILE, 'utf8').trim() || null;
  } catch {
    /* no cache yet */
  }

  const candidates = cached
    ? [cached, ...agentHostCandidates().filter((h) => h !== cached)]
    : agentHostCandidates();

  let socket = null;
  const failures = [];
  for (const host of candidates) {
    try {
      socket = await dial(host, port, Math.min(timeoutMs, 4000));
      if (host !== cached) {
        try {
          fs.writeFileSync(CACHE_FILE, host);
        } catch {
          /* best effort */
        }
      }
      break;
    } catch (err) {
      failures.push(err.message);
    }
  }
  if (!socket) {
    throw new Error(
      `cannot reach the cc-docker host agent on port ${port}. Tried:\n  ${failures.join('\n  ')}`,
    );
  }

  socket.write(JSON.stringify({ token: agentToken(), ...hello }) + '\n');
  const { hello: ack, rest } = await readHello(socket, { timeoutMs });
  if (!ack.ok) {
    socket.destroy();
    throw new Error(ack.error || 'host agent refused the request');
  }
  return { socket, ack, rest };
}

/**
 * Runs a host process and mirrors it onto this process's stdio, so that from
 * Claude Code's point of view it is an ordinary local child process.
 */
export async function runProcess(hello) {
  const { socket, rest } = await connect(hello);

  const reader = new FrameReader((frame) => {
    switch (frame.t) {
      case 'o':
        process.stdout.write(unb64(frame.b));
        break;
      case 'e':
        process.stderr.write(unb64(frame.b));
        break;
      case 'x': {
        const code = frame.c == null ? (frame.s ? 1 : 0) : frame.c;
        // Flush before exiting: stdout may be a pipe with buffered data.
        process.stdout.write('', () => process.exit(code));
        setTimeout(() => process.exit(code), 2000).unref();
        break;
      }
    }
  }, (err) => process.stderr.write(`cc-docker: bad frame from host agent: ${err.message}\n`));

  if (rest && rest.length) reader.push(rest);
  socket.on('data', (chunk) => reader.push(chunk));

  process.stdin.on('data', (chunk) => {
    if (!writeFrame(socket, { t: 'i', b: b64(chunk) })) process.stdin.pause();
  });
  socket.on('drain', () => process.stdin.resume());
  process.stdin.on('end', () => writeFrame(socket, { t: 'ie' }));

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => writeFrame(socket, { t: 'sig', s: signal }));
  }

  socket.on('close', () => process.exit(0));
  socket.on('error', (err) => {
    process.stderr.write(`cc-docker: host agent connection lost: ${err.message}\n`);
    process.exit(1);
  });
}

/**
 * Long-lived relay: accepts reverse-tunnel connections from the host and wires
 * each one to a TCP port inside this container. This is what allows the host
 * browser to reach an OAuth callback listener bound to container loopback.
 */
export async function runRelay({ forward = [] } = {}) {
  const { socket, rest } = await connect({ op: 'relay', session: sessionId(), forward });
  const conns = new Map();

  const reader = new FrameReader((frame) => {
    switch (frame.t) {
      case 'conn': {
        const upstream = net.createConnection({ host: '127.0.0.1', port: frame.port });
        upstream.setNoDelay(true);
        conns.set(frame.id, upstream);
        upstream.on('data', (d) => {
          if (!writeFrame(socket, { t: 'd', id: frame.id, b: b64(d) })) upstream.pause();
        });
        upstream.on('close', () => {
          if (conns.delete(frame.id)) writeFrame(socket, { t: 'close', id: frame.id });
        });
        upstream.on('error', (err) => {
          conns.delete(frame.id);
          writeFrame(socket, { t: 'connerr', id: frame.id, m: err.message });
          upstream.destroy();
        });
        break;
      }
      case 'd': {
        const conn = conns.get(frame.id);
        if (conn && !conn.destroyed) conn.write(unb64(frame.b));
        break;
      }
      case 'close': {
        const conn = conns.get(frame.id);
        if (conn) conn.end();
        conns.delete(frame.id);
        break;
      }
    }
  }, () => {});

  socket.on('drain', () => {
    for (const conn of conns.values()) conn.resume();
  });
  if (rest && rest.length) reader.push(rest);
  socket.on('data', (chunk) => reader.push(chunk));

  const heartbeat = setInterval(() => writeFrame(socket, { t: 'hb' }), 30_000);
  heartbeat.unref();

  return new Promise((resolve) => {
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const conn of conns.values()) conn.destroy();
      resolve();
    });
    socket.on('error', () => {
      /* close follows */
    });
  });
}
