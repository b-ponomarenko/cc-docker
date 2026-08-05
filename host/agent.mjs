#!/usr/bin/env node
//
// cc-docker host agent.
//
// Runs on the *host*, outside the container, and is the single hole through
// which the containerised Claude Code reaches the local environment:
//
//   op=mcp     spawn a locally-installed stdio MCP server on the host and pipe
//              its stdio into the container (native host binaries, host-only
//              runtimes and host-only credentials all keep working)
//   op=exec    run an allow-listed host command (open, pbcopy, osascript, ...)
//   op=open    open a URL in the *host* browser, and — crucially — reverse
//              tunnel any localhost port the URL wants to redirect back to,
//              which is what makes subscription OAuth login work
//   op=relay   long-lived multiplexed reverse TCP tunnel owned by one session
//   op=info    introspection for `doclaude self doctor`
//
// Security model: loopback-bound (or docker-bridge-bound on Linux) TCP with a
// shared secret that only exists inside the user's own home directory. Command
// execution is allow-listed by default.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readHello, FrameReader, writeFrame, b64, unb64 } from '../shared/proto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CCD_DIR = process.env.DOCLAUDE_DIR || path.join(os.homedir(), '.cc-docker');
const RUN_FILE = path.join(CCD_DIR, 'run', 'agent.json');
const LOG_FILE = path.join(CCD_DIR, 'logs', 'agent.log');
const TOKEN_FILE = path.join(CCD_DIR, 'agent.token');
const CONFIG_FILE = path.join(CCD_DIR, 'config.json');

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });

function rotateIfBig() {
  try {
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {
    /* first run */
  }
}
rotateIfBig();

let logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`;
  logStream.write(line);
  if (process.env.DOCLAUDE_AGENT_FOREGROUND === '1') process.stderr.write(line);
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// Deliberately conservative. `security`, `docker` and friends are omitted: each
// would hand the container a way out of its own sandbox, and a user who wants
// that can say so explicitly in config.json.
const DEFAULT_HOST_COMMANDS = [
  'open', 'xdg-open',
  'pbcopy', 'pbpaste', 'wl-copy', 'wl-paste', 'xclip', 'xsel',
  'osascript', 'say', 'terminal-notifier', 'notify-send',
];

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const cfg = readJson(CONFIG_FILE, {}) || {};
  return {
    hostCommands: DEFAULT_HOST_COMMANDS,
    allowAnyHostExec: false,
    useLoginShell: true,
    mcpServers: {},
    idleShutdownMinutes: 0,
    ...cfg,
  };
}

let config = loadConfig();
fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => {
  config = loadConfig();
  log('config reloaded');
});

const TOKEN = (() => {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    console.error(`cc-docker: missing token file ${TOKEN_FILE}; run install.sh`);
    process.exit(1);
  }
})();

// ---------------------------------------------------------------------------
// MCP server resolution — always read the *live* host config so that servers
// added with `claude mcp add` on the host show up without reinstalling.
// ---------------------------------------------------------------------------

function hostClaudeJsonPaths() {
  const paths = [];
  if (config.hostClaudeJson) paths.push(config.hostClaudeJson);
  if (config.hostClaudeDir) paths.push(path.join(config.hostClaudeDir, '.claude.json'));
  paths.push(path.join(os.homedir(), '.claude.json'));
  paths.push(path.join(os.homedir(), '.claude', '.claude.json'));
  return [...new Set(paths)];
}

function resolveMcpServer(name, cwd) {
  // 1. explicit override in cc-docker config wins
  if (config.mcpServers && config.mcpServers[name]) {
    return { ...config.mcpServers[name], _source: 'cc-docker config' };
  }
  // 2. a project-committed .mcp.json, so `overrides: {"x": "host"}` works for
  //    servers that live with the repo rather than in the user's config
  if (cwd) {
    const projectFile = path.join(cwd, '.mcp.json');
    const projectData = readJson(projectFile);
    if (projectData && projectData.mcpServers && projectData.mcpServers[name]) {
      return { ...projectData.mcpServers[name], _source: projectFile };
    }
  }
  for (const file of hostClaudeJsonPaths()) {
    const data = readJson(file);
    if (!data) continue;
    if (data.mcpServers && data.mcpServers[name]) {
      return { ...data.mcpServers[name], _source: `${file} (global)` };
    }
    const projects = data.projects || {};
    // prefer the project matching the caller's cwd, then any project
    const ordered = [
      ...(cwd && projects[cwd] ? [[cwd, projects[cwd]]] : []),
      ...Object.entries(projects),
    ];
    for (const [projPath, proj] of ordered) {
      if (proj && proj.mcpServers && proj.mcpServers[name]) {
        return { ...proj.mcpServers[name], _source: `${file} (project ${projPath})` };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// spawning on the host
// ---------------------------------------------------------------------------

function loginShell() {
  const shell = process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return shell;
}

/**
 * Spawn a host process. When `useLoginShell` is on we go through `$SHELL -lc`
 * so the child sees the same PATH/env the user gets in a terminal — otherwise
 * tools installed by nvm/mise/asdf/homebrew are mysteriously "not found".
 */
function spawnHost(cmd, args, { cwd, env, tty = false }) {
  const useCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const childEnv = { ...process.env, ...(env || {}) };
  // never let container-side plumbing leak into host children
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('DOCLAUDE_')) delete childEnv[k];
  }
  childEnv.DOCLAUDE_HOST_AGENT = '1';

  if (config.useLoginShell) {
    return spawn(loginShell(), ['-lc', 'exec "$0" "$@"', cmd, ...args], {
      cwd: useCwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(cmd, args, {
    cwd: useCwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Wire a spawned child to a socket using the process frame protocol. */
function pipeProcess(socket, child, label) {
  const reader = new FrameReader((frame) => {
    switch (frame.t) {
      case 'i':
        if (!child.stdin.destroyed) child.stdin.write(unb64(frame.b));
        break;
      case 'ie':
        if (!child.stdin.destroyed) child.stdin.end();
        break;
      case 'sig':
        try {
          child.kill(frame.s || 'SIGTERM');
        } catch {
          /* already gone */
        }
        break;
    }
  }, (err) => log(label, 'bad frame from client:', err.message));

  socket.on('data', (chunk) => reader.push(chunk));

  child.stdout.on('data', (d) => {
    if (!writeFrame(socket, { t: 'o', b: b64(d) })) child.stdout.pause();
  });
  socket.on('drain', () => {
    child.stdout.resume();
    child.stderr.resume();
  });
  child.stderr.on('data', (d) => {
    if (!writeFrame(socket, { t: 'e', b: b64(d) })) child.stderr.pause();
  });

  const finish = (code, signal) => {
    writeFrame(socket, { t: 'x', c: code == null ? null : code, s: signal || null });
    socket.end();
  };
  child.on('exit', finish);
  child.on('error', (err) => {
    writeFrame(socket, { t: 'e', b: b64(`cc-docker: ${err.message}\n`) });
    finish(127, null);
  });

  const kill = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000).unref();
  };
  socket.on('close', kill);
  socket.on('error', kill);
}

// ---------------------------------------------------------------------------
// sessions and the reverse TCP tunnel
// ---------------------------------------------------------------------------

/** sessionId -> { socket, tunnels: Map<port, net.Server>, conns: Map<id, net.Socket> } */
const sessions = new Map();
const sessionWaiters = new Map(); // sessionId -> [resolve, ...]
let connSeq = 0;

function registerSession(id, socket) {
  const prev = sessions.get(id);
  if (prev && prev.socket !== socket) closeSession(id, 'replaced');

  const session = { id, socket, tunnels: new Map(), conns: new Map(), startedAt: Date.now() };
  sessions.set(id, session);

  const reader = new FrameReader((frame) => {
    if (frame.t === 'hb') return;
    const conn = session.conns.get(frame.id);
    switch (frame.t) {
      case 'd':
        if (conn && !conn.destroyed) conn.write(unb64(frame.b));
        break;
      case 'close':
      case 'connerr':
        if (frame.t === 'connerr') log(`session ${id} tunnel connect error:`, frame.m);
        if (conn) conn.end();
        session.conns.delete(frame.id);
        break;
    }
  }, (err) => log(`session ${id} bad relay frame:`, err.message));

  socket.on('data', (chunk) => reader.push(chunk));
  // One shared drain handler: attaching one per tunnelled connection would trip
  // the max-listeners warning on a busy session.
  socket.on('drain', () => {
    for (const conn of session.conns.values()) conn.resume();
  });
  socket.on('close', () => closeSession(id, 'relay closed'));
  socket.on('error', () => closeSession(id, 'relay error'));

  const waiters = sessionWaiters.get(id) || [];
  sessionWaiters.delete(id);
  waiters.forEach((resolve) => resolve(session));

  log(`session ${id} registered`);
  return session;
}

function closeSession(id, why) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const [port, server] of session.tunnels) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    log(`session ${id} released tunnel port ${port}`);
  }
  for (const conn of session.conns.values()) conn.destroy();
  try {
    session.socket.destroy();
  } catch {
    /* ignore */
  }
  log(`session ${id} closed (${why})`);
}

function waitForSession(id, ms) {
  const existing = sessions.get(id);
  if (existing) return Promise.resolve(existing);
  if (!ms) return Promise.resolve(null);
  return new Promise((resolve) => {
    const list = sessionWaiters.get(id) || [];
    const timer = setTimeout(() => resolve(sessions.get(id) || null), ms);
    list.push((s) => {
      clearTimeout(timer);
      resolve(s);
    });
    sessionWaiters.set(id, list);
  });
}

/**
 * Bind `port` on the host loopback and forward every connection into the
 * container over the session's relay. This is what lets a browser running on
 * the host reach an OAuth callback listener that only exists inside the
 * container, on a port neither side chose in advance.
 */
function ensureTunnel(session, port) {
  if (session.tunnels.has(port)) return Promise.resolve({ ok: true, existing: true });

  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      const id = ++connSeq;
      session.conns.set(id, conn);
      writeFrame(session.socket, { t: 'conn', id, port });

      conn.on('data', (d) => {
        if (!writeFrame(session.socket, { t: 'd', id, b: b64(d) })) conn.pause();
      });
      conn.on('close', () => {
        if (session.conns.delete(id)) writeFrame(session.socket, { t: 'close', id });
      });
      conn.on('error', () => conn.destroy());
    });

    server.once('error', (err) => {
      log(`tunnel bind failed on ${port}:`, err.message);
      resolve({ ok: false, error: err.message });
    });
    server.listen(port, '127.0.0.1', () => {
      session.tunnels.set(port, server);
      log(`session ${session.id} tunnelling host 127.0.0.1:${port} -> container :${port}`);
      resolve({ ok: true });
    });
  });
}

// ---------------------------------------------------------------------------
// browser opening
// ---------------------------------------------------------------------------

/** Ports the container will expect the browser to come back to. */
function localCallbackPorts(rawUrl) {
  const ports = new Set();
  const isLocal = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  if (isLocal(url.hostname) && url.port) ports.add(Number(url.port));

  // OAuth: the interesting port hides inside redirect_uri
  for (const key of ['redirect_uri', 'redirect_url', 'callback', 'return_to']) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    try {
      const inner = new URL(value);
      if (isLocal(inner.hostname) && inner.port) ports.add(Number(inner.port));
    } catch {
      /* not a URL */
    }
  }
  return [...ports].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
}

function openInHostBrowser(url) {
  const explicit = config.browserCommand || process.env.DOCLAUDE_HOST_BROWSER;
  let cmd;
  let args;
  if (explicit) {
    const parts = explicit.split(/\s+/);
    cmd = parts[0];
    args = [...parts.slice(1), url];
  } else if (os.platform() === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (os.platform() === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, env: process.env });
  child.on('error', (err) => log('browser open failed:', err.message));
  child.unref();
}

// ---------------------------------------------------------------------------
// connection handling
// ---------------------------------------------------------------------------

function isCommandAllowed(cmd) {
  if (config.allowAnyHostExec) return true;
  const base = path.basename(cmd);
  return (config.hostCommands || []).some((c) => path.basename(c) === base);
}

async function handleConnection(socket) {
  socket.setNoDelay(true);

  let hello;
  let rest;
  try {
    ({ hello, rest } = await readHello(socket));
  } catch (err) {
    log('handshake failed:', err.message);
    socket.destroy();
    return;
  }

  if (hello.token !== TOKEN) {
    log('rejected connection: bad token');
    writeFrame(socket, { ok: false, error: 'unauthorized' });
    socket.destroy();
    return;
  }

  const ack = (obj) => writeFrame(socket, { ok: true, v: 1, ...obj });

  switch (hello.op) {
    case 'ping':
      ack({ pong: true, pid: process.pid });
      socket.end();
      return;

    case 'info':
      ack({
        pid: process.pid,
        platform: os.platform(),
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          tunnels: [...s.tunnels.keys()],
          startedAt: s.startedAt,
        })),
        hostCommands: config.hostCommands,
        allowAnyHostExec: !!config.allowAnyHostExec,
      });
      socket.end();
      return;

    case 'relay': {
      if (!hello.session) {
        writeFrame(socket, { ok: false, error: 'relay requires a session id' });
        socket.destroy();
        return;
      }
      ack({ session: hello.session });
      const session = registerSession(hello.session, socket);
      if (rest && rest.length) socket.emit('data', rest);
      // Pre-open any ports the launcher asked us to expose (dev servers etc).
      for (const port of hello.forward || []) ensureTunnel(session, Number(port));
      return;
    }

    case 'open': {
      const url = String(hello.url || '');
      if (!url) {
        writeFrame(socket, { ok: false, error: 'open requires a url' });
        socket.destroy();
        return;
      }
      const ports = localCallbackPorts(url);
      const tunnelled = [];
      if (ports.length) {
        const session = await waitForSession(hello.session, 4000);
        if (session) {
          for (const port of ports) {
            const result = await ensureTunnel(session, port);
            if (result.ok) tunnelled.push(port);
          }
        } else {
          log(`open: no relay for session ${hello.session}; cannot tunnel ${ports.join(',')}`);
        }
      }
      log(`open ${url}${tunnelled.length ? ` (tunnelled ${tunnelled.join(',')})` : ''}`);
      openInHostBrowser(url);
      ack({ opened: true, tunnelled, requestedPorts: ports });
      socket.end();
      return;
    }

    case 'mcp': {
      const name = hello.name;
      const server = resolveMcpServer(name, hello.cwd);
      if (!server) {
        writeFrame(socket, { ok: false, error: `unknown MCP server "${name}" on the host` });
        socket.destroy();
        return;
      }
      if (!server.command) {
        writeFrame(socket, {
          ok: false,
          error: `MCP server "${name}" is not a stdio server (type=${server.type || 'unknown'})`,
        });
        socket.destroy();
        return;
      }
      log(`mcp ${name} -> ${server.command} ${(server.args || []).join(' ')} [${server._source}]`);
      ack({ server: name });
      const child = spawnHost(server.command, server.args || [], {
        cwd: hello.cwd,
        env: server.env,
      });
      pipeProcess(socket, child, `mcp:${name}`);
      if (rest && rest.length) child.stdin.write(rest);
      return;
    }

    case 'exec': {
      const cmd = String(hello.cmd || '');
      if (!cmd) {
        writeFrame(socket, { ok: false, error: 'exec requires a cmd' });
        socket.destroy();
        return;
      }
      if (!isCommandAllowed(cmd)) {
        writeFrame(socket, {
          ok: false,
          error:
            `host command "${cmd}" is not allow-listed. ` +
            `Add it to hostCommands in ~/.cc-docker/config.json.`,
        });
        socket.destroy();
        return;
      }
      log(`exec ${cmd} ${(hello.args || []).join(' ')}`);
      ack({ cmd });
      const child = spawnHost(cmd, hello.args || [], { cwd: hello.cwd, env: hello.env });
      pipeProcess(socket, child, `exec:${cmd}`);
      if (rest && rest.length) child.stdin.write(rest);
      return;
    }

    case 'shutdown':
      ack({ bye: true });
      socket.end();
      log('shutdown requested');
      setTimeout(() => process.exit(0), 100);
      return;

    default:
      writeFrame(socket, { ok: false, error: `unknown op "${hello.op}"` });
      socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

const bindHost = process.env.DOCLAUDE_AGENT_BIND || config.agentBind || '127.0.0.1';
let wantPort = Number(process.env.DOCLAUDE_AGENT_PORT || config.agentPort || 0);

/**
 * Remember the port across restarts. Container runtimes proxy host-loopback
 * services in userspace, and a port that moves on every restart leaves that
 * proxy — and any firewall rule the user wrote — pointing at nothing.
 */
function persistPort(port) {
  try {
    const current = readJson(CONFIG_FILE, {}) || {};
    if (current.agentPort === port) return;
    current.agentPort = port;
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    log('could not persist agent port:', err.message);
  }
}

const server = net.createServer(handleConnection);
server.on('error', (err) => {
  // The remembered port may have been taken by something else in the meantime;
  // fall back to a fresh one rather than refusing to start.
  if (err.code === 'EADDRINUSE' && wantPort) {
    log(`port ${wantPort} is in use, choosing another`);
    wantPort = 0;
    server.listen(0, bindHost);
    return;
  }
  log('server error:', err.message);
  console.error(`cc-docker agent: ${err.message}`);
  process.exit(1);
});

server.on('listening', () => {
  const { port } = server.address();
  fs.writeFileSync(
    RUN_FILE,
    JSON.stringify({ pid: process.pid, host: bindHost, port, startedAt: Date.now() }, null, 2),
  );
  persistPort(port);
  log(`agent listening on ${bindHost}:${port} (pid ${process.pid}, node ${process.version})`);
  if (process.env.DOCLAUDE_AGENT_FOREGROUND === '1') {
    console.log(`cc-docker agent listening on ${bindHost}:${port}`);
  }
});

server.listen(wantPort, bindHost);

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  for (const id of [...sessions.keys()]) closeSession(id, 'agent shutdown');
  try {
    fs.unlinkSync(RUN_FILE);
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log('uncaught:', err.stack || String(err)));
process.on('unhandledRejection', (err) => log('unhandled rejection:', String(err)));

if (config.idleShutdownMinutes > 0) {
  setInterval(() => {
    if (sessions.size === 0) {
      log('idle timeout reached');
      shutdown('idle');
    }
  }, config.idleShutdownMinutes * 60_000).unref();
}
