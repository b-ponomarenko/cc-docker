// End-to-end tests for the host agent and the wire protocol.
//
// These run without Docker: they drive the agent exactly as the in-container
// clients do. The one thing that cannot be faked on a single machine is the
// container's own loopback, so the reverse tunnel is exercised with a mock
// container that dials a different port than the one the agent binds.
//
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FrameReader, writeFrame, b64, unb64, readHello } from '../shared/proto.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AGENT = path.join(REPO, 'host', 'agent.mjs');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

async function startAgent(configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-'));
  const fakeHome = path.join(dir, 'fakehome');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'run'), { recursive: true });

  const token = 'test-token-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(path.join(dir, 'agent.token'), token);

  const browserLog = path.join(dir, 'browser.log');
  const browserScript = path.join(dir, 'fake-browser.sh');
  fs.writeFileSync(browserScript, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(browserLog)}\n`);
  fs.chmodSync(browserScript, 0o755);

  const config = {
    useLoginShell: false,
    allowAnyHostExec: false,
    hostCommands: ['echo', 'cat', 'sh', 'false'],
    browserCommand: browserScript,
    hostClaudeJson: path.join(fakeHome, '.claude.json'),
    hostClaudeDir: path.join(fakeHome, '.claude'),
    ...configOverrides,
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

  const child = spawn(process.execPath, [AGENT], {
    env: { ...process.env, DOCLAUDE_DIR: dir, DOCLAUDE_AGENT_BIND: '127.0.0.1', DOCLAUDE_AGENT_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const runFile = path.join(dir, 'run', 'agent.json');
  let info = null;
  for (let i = 0; i < 100 && !info; i += 1) {
    await sleep(50);
    try {
      info = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    } catch {
      /* not up yet */
    }
  }
  if (!info) {
    child.kill('SIGKILL');
    throw new Error('agent failed to start:\n' + safeRead(path.join(dir, 'logs', 'agent.log')));
  }

  return {
    dir,
    fakeHome,
    token,
    port: info.port,
    browserLog,
    logFile: path.join(dir, 'logs', 'agent.log'),
    stop() {
      child.kill('SIGTERM');
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeRead = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '(no log)';
  }
};

/** Opens a connection and completes the handshake, mirroring container/lib/client.mjs. */
async function connect(agent, hello) {
  const socket = net.createConnection({ host: '127.0.0.1', port: agent.port });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(JSON.stringify({ token: agent.token, ...hello }) + '\n');
  const { hello: ack, rest } = await readHello(socket, { timeoutMs: 10000 });
  return { socket, ack, rest };
}

/** Runs a process op to completion, collecting stdout/stderr and the exit code. */
async function runProcessOp(agent, hello, stdin = null) {
  const { socket, ack, rest } = await connect(agent, hello);
  if (!ack.ok) {
    socket.destroy();
    return { ack, stdout: '', stderr: '', code: null };
  }
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve) => {
    const reader = new FrameReader((frame) => {
      if (frame.t === 'o') stdout += unb64(frame.b).toString();
      else if (frame.t === 'e') stderr += unb64(frame.b).toString();
      else if (frame.t === 'x') resolve(frame.c);
    });
    if (rest && rest.length) reader.push(rest);
    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('close', () => resolve(null));
  });

  if (stdin != null) writeFrame(socket, { t: 'i', b: b64(stdin) });
  writeFrame(socket, { t: 'ie' });

  const code = await done;
  socket.destroy();
  return { ack, stdout, stderr, code };
}

/**
 * Mock container relay. Instead of dialling the same port the agent bound (which
 * would collide on a single host), it dials `targetPort`.
 */
function mockRelay(agent, session, targetPort) {
  return connect(agent, { op: 'relay', session }).then(({ socket, ack, rest }) => {
    assert.equal(ack.ok, true);
    const conns = new Map();
    const reader = new FrameReader((frame) => {
      if (frame.t === 'conn') {
        const upstream = net.createConnection({ host: '127.0.0.1', port: targetPort });
        conns.set(frame.id, upstream);
        upstream.on('data', (d) => writeFrame(socket, { t: 'd', id: frame.id, b: b64(d) }));
        upstream.on('close', () => {
          if (conns.delete(frame.id)) writeFrame(socket, { t: 'close', id: frame.id });
        });
        upstream.on('error', (err) => writeFrame(socket, { t: 'connerr', id: frame.id, m: err.message }));
      } else if (frame.t === 'd') {
        const conn = conns.get(frame.id);
        if (conn && !conn.destroyed) conn.write(unb64(frame.b));
      } else if (frame.t === 'close') {
        const conn = conns.get(frame.id);
        if (conn) conn.end();
        conns.delete(frame.id);
      }
    });
    if (rest && rest.length) reader.push(rest);
    socket.on('data', (chunk) => reader.push(chunk));
    socket.on('error', () => {});
    return {
      socket,
      close() {
        for (const c of conns.values()) c.destroy();
        socket.destroy();
      },
    };
  });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('rejects a connection with a wrong token', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const socket = net.createConnection({ host: '127.0.0.1', port: agent.port });
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(JSON.stringify({ token: 'nope', op: 'ping' }) + '\n');
  const { hello } = await readHello(socket, { timeoutMs: 5000 });
  socket.destroy();

  assert.equal(hello.ok, false);
  assert.equal(hello.error, 'unauthorized');
});

test('answers ping', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const { socket, ack } = await connect(agent, { op: 'ping' });
  socket.destroy();
  assert.equal(ack.ok, true);
  assert.equal(ack.pong, true);
});

test('exec runs an allow-listed command and reports its exit code', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const ok = await runProcessOp(agent, { op: 'exec', cmd: 'echo', args: ['hello from the host'] });
  assert.equal(ok.ack.ok, true);
  assert.equal(ok.stdout.trim(), 'hello from the host');
  assert.equal(ok.code, 0);

  const failing = await runProcessOp(agent, { op: 'exec', cmd: 'false', args: [] });
  assert.equal(failing.code, 1);
});

test('exec refuses a command that is not allow-listed', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const { ack } = await runProcessOp(agent, { op: 'exec', cmd: 'whoami', args: [] });
  assert.equal(ack.ok, false);
  assert.match(ack.error, /not allow-listed/);
});

test('exec streams stdin through to the host process', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const result = await runProcessOp(agent, { op: 'exec', cmd: 'cat', args: [] }, 'round trip\n');
  assert.equal(result.stdout, 'round trip\n');
  assert.equal(result.code, 0);
});

test('exec separates stderr from stdout', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const result = await runProcessOp(agent, {
    op: 'exec',
    cmd: 'sh',
    args: ['-c', 'echo out; echo err >&2; exit 3'],
  });
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.code, 3);
});

test('mcp resolves a stdio server from the host .claude.json and pipes it', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  // A stand-in MCP server: reads a line, writes a JSON-RPC-shaped reply.
  const serverScript = path.join(agent.dir, 'fake-mcp.mjs');
  fs.writeFileSync(
    serverScript,
    `let buf='';
     process.stdin.on('data', (c) => {
       buf += c;
       let i;
       while ((i = buf.indexOf('\\n')) !== -1) {
         const line = buf.slice(0, i); buf = buf.slice(i + 1);
         const msg = JSON.parse(line);
         process.stderr.write('handled ' + msg.method + '\\n');
         process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }) + '\\n');
       }
     });`,
  );
  fs.writeFileSync(
    path.join(agent.fakeHome, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        fake: { type: 'stdio', command: process.execPath, args: [serverScript] },
      },
    }),
  );

  const { socket, ack, rest } = await connect(agent, { op: 'mcp', name: 'fake', cwd: agent.dir });
  assert.equal(ack.ok, true);

  let stdout = '';
  let stderr = '';
  const reader = new FrameReader((frame) => {
    if (frame.t === 'o') stdout += unb64(frame.b).toString();
    if (frame.t === 'e') stderr += unb64(frame.b).toString();
  });
  if (rest && rest.length) reader.push(rest);
  socket.on('data', (chunk) => reader.push(chunk));

  writeFrame(socket, { t: 'i', b: b64(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n') });

  for (let i = 0; i < 100 && !stdout.includes('echoed'); i += 1) await sleep(50);
  socket.destroy();

  assert.match(stdout, /"echoed":"initialize"/);
  // stderr must survive the trip: it is where MCP servers report their problems.
  assert.match(stderr, /handled initialize/);
});

test('mcp reports an unknown server instead of hanging', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  fs.writeFileSync(path.join(agent.fakeHome, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const { socket, ack } = await connect(agent, { op: 'mcp', name: 'ghost', cwd: agent.dir });
  socket.destroy();
  assert.equal(ack.ok, false);
  assert.match(ack.error, /unknown MCP server/);
});

test('open tunnels the OAuth callback port back into the container', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  // Stands in for Claude Code's OAuth listener inside the container.
  const containerPort = await freePort();
  const callbackServer = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'https://claude.ai/success' });
    res.end(`got ${req.url}`);
  });
  await new Promise((resolve) => callbackServer.listen(containerPort, '127.0.0.1', resolve));
  t.after(() => callbackServer.close());

  const relay = await mockRelay(agent, 'session-1', containerPort);
  t.after(() => relay.close());

  // The port the *host* must bind is the one baked into redirect_uri.
  const hostPort = await freePort();
  const authUrl =
    `https://claude.ai/oauth/authorize?code=true&client_id=x&` +
    `redirect_uri=${encodeURIComponent(`http://localhost:${hostPort}/callback`)}&state=abc`;

  const { socket, ack } = await connect(agent, { op: 'open', url: authUrl, session: 'session-1' });
  socket.destroy();

  assert.equal(ack.ok, true);
  assert.deepEqual(ack.requestedPorts, [hostPort]);
  assert.deepEqual(ack.tunnelled, [hostPort], 'the callback port must be bound on the host');

  // The browser was actually launched, with the untouched URL.
  for (let i = 0; i < 40 && !fs.existsSync(agent.browserLog); i += 1) await sleep(50);
  assert.match(fs.readFileSync(agent.browserLog, 'utf8'), /oauth\/authorize/);

  // Now do what the browser does: hit the host port, expect the container's reply.
  const response = await new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: hostPort, path: '/callback?code=xyz&state=abc' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      },
    );
    req.on('error', reject);
  });

  assert.equal(response.status, 302);
  assert.equal(response.location, 'https://claude.ai/success');
  assert.match(response.body, /code=xyz/);
});

test('open still launches the browser when no session can be tunnelled', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const { socket, ack } = await connect(agent, {
    op: 'open',
    url: 'https://docs.claude.com/',
    session: 'nobody',
  });
  socket.destroy();

  assert.equal(ack.ok, true);
  assert.deepEqual(ack.requestedPorts, []);
  for (let i = 0; i < 40 && !fs.existsSync(agent.browserLog); i += 1) await sleep(50);
  assert.match(fs.readFileSync(agent.browserLog, 'utf8'), /docs\.claude\.com/);
});

test('closing a session releases its tunnelled ports', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const containerPort = await freePort();
  const hostPort = await freePort();
  const relay = await mockRelay(agent, 'session-2', containerPort);

  const { socket } = await connect(agent, {
    op: 'open',
    url: `http://localhost:${hostPort}/x`,
    session: 'session-2',
  });
  socket.destroy();

  // The agent now owns hostPort; binding it must fail.
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(hostPort, '127.0.0.1', () => probe.close(resolve));
      }),
  );

  relay.close();
  await sleep(500);

  // After the session goes away the port must be free again.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(hostPort, '127.0.0.1', () => probe.close(resolve));
  });
});

test('info reports live sessions and their tunnels', async (t) => {
  const agent = await startAgent();
  t.after(() => agent.stop());

  const containerPort = await freePort();
  const relay = await mockRelay(agent, 'session-3', containerPort);
  t.after(() => relay.close());

  const hostPort = await freePort();
  const opened = await connect(agent, {
    op: 'open',
    url: `http://127.0.0.1:${hostPort}/`,
    session: 'session-3',
  });
  opened.socket.destroy();

  const { socket, ack } = await connect(agent, { op: 'info' });
  socket.destroy();

  assert.equal(ack.ok, true);
  const session = ack.sessions.find((s) => s.id === 'session-3');
  assert.ok(session, 'session must be registered');
  assert.deepEqual(session.tunnels, [hostPort]);
});
