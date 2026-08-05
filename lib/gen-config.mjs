#!/usr/bin/env node
// Generates (or refreshes) ~/.cc-docker/config.json.
//
// Re-running install.sh must never silently discard hand edits, so this merges
// three layers: built-in defaults < the existing file < flags passed by the
// installer. Only keys the user has not touched move with new defaults.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

const CCD_DIR = flag('ccd-dir', path.join(os.homedir(), '.cc-docker'));
const CONFIG_FILE = path.join(CCD_DIR, 'config.json');
const REPO_DIR = flag('repo', process.cwd());
const VERSION = flag('version', '0.1.0');

function which(cmd) {
  const result = spawnSync('command', ['-v', cmd], { shell: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

// --- host-only commands worth exposing inside the container ------------------

// Everyday desktop integration only. Anything that could hand the container the
// keys to the host — `security`, `docker`, `sudo`, `systemctl` — is left out on
// purpose; adding it is a conscious edit to config.json.
const SHIM_CANDIDATES = {
  darwin: ['open', 'pbcopy', 'pbpaste', 'osascript', 'say', 'terminal-notifier'],
  linux: ['xdg-open', 'wl-copy', 'wl-paste', 'xclip', 'xsel', 'notify-send'],
  win32: ['explorer.exe', 'clip.exe'],
};

function detectShimCommands() {
  const candidates = SHIM_CANDIDATES[process.platform] || SHIM_CANDIDATES.linux;
  return candidates.filter((cmd) => which(cmd));
}

// --- where the container should talk to the agent ---------------------------

function detectAgentBind() {
  if (process.platform !== 'linux') return '127.0.0.1';
  for (const docker of ['docker', 'podman']) {
    try {
      const gateway = execFileSync(
        docker,
        ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (gateway) return gateway;
    } catch {
      /* try the next runtime */
    }
  }
  return '172.17.0.1';
}

// --- defaults ---------------------------------------------------------------

const home = os.homedir();
const shims = detectShimCommands();

const defaults = {
  version: VERSION,
  repoDir: REPO_DIR,
  libDir: path.join(CCD_DIR, 'lib'),

  image: 'cc-docker:latest',
  claudeVersion: 'latest',
  extraAptPackages: '',

  hostHome: home,
  hostUser: os.userInfo().username,
  hostUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
  hostGid: typeof process.getgid === 'function' ? process.getgid() : 1000,
  hostClaudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  hostClaudeJson: process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(home, '.claude.json'),
  claudeConfigDir: path.join(CCD_DIR, 'claude'),
  nodeBin: process.execPath,
  // Extra roots for TLS-inspecting networks; refreshed by install.sh.
  caBundle: path.join(CCD_DIR, 'certs', 'extra-ca.crt'),

  agentBind: detectAgentBind(),
  agentPort: 0,

  // 'home' gives Claude Code the same view of the filesystem it has on the
  // host; 'project' restricts it to the working directory plus what it needs.
  mountProfile: 'home',
  extraMounts: [],
  extraDockerArgs: [],
  containerSudo: true,
  containerHostname: 'doclaude',

  // Live linkage: these are symlinked at the host's ~/.claude inside the
  // container, so installing a skill or plugin on the host takes effect at once.
  linkFromHost: ['skills', 'plugins', 'agents', 'commands', 'hooks', 'output-styles', 'scripts'],
  settingsMode: 'copy',

  // stdio MCP servers run on the host (native binaries, host runtimes, host
  // credentials); http/sse servers are reached directly from the container.
  mcpPolicy: { stdio: 'host', remote: 'container', overrides: {} },

  shimCommands: shims,
  hostCommands: [...new Set([...shims, 'open', 'xdg-open'])],
  allowAnyHostExec: false,
  hostFallback: true,
  useLoginShell: true,

  forwardEnv: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ],
  // 'auto' picks the Docker Desktop magic socket on macOS and the real socket
  // path on Linux. SSH_AUTH_SOCK is handled here rather than in forwardEnv
  // because forwarding the variable without the socket only breaks git.
  sshAgentMode: 'auto',
  forwardPorts: [],
  env: {},
};

// --- merge ------------------------------------------------------------------

let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  /* first install */
}

const overrides = {};
if (flag('image')) overrides.image = flag('image');
if (flag('claude-version')) overrides.claudeVersion = flag('claude-version');
if (flag('profile')) overrides.mountProfile = flag('profile');
if (flag('apt')) overrides.extraAptPackages = flag('apt');

const merged = {
  ...defaults,
  ...existing,
  ...overrides,
  // These describe *this* machine and this checkout; they must always refresh.
  version: VERSION,
  repoDir: REPO_DIR,
  libDir: path.join(CCD_DIR, 'lib'),
  hostHome: defaults.hostHome,
  hostUser: defaults.hostUser,
  hostUid: defaults.hostUid,
  hostGid: defaults.hostGid,
  nodeBin: defaults.nodeBin,
  mcpPolicy: { ...defaults.mcpPolicy, ...(existing.mcpPolicy || {}) },
};

// A stale Linux bind address silently breaks every container -> host call.
if (process.platform === 'linux' && merged.agentBind === '127.0.0.1') {
  merged.agentBind = defaults.agentBind;
}

fs.mkdirSync(CCD_DIR, { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');

process.stdout.write(
  JSON.stringify(
    {
      configFile: CONFIG_FILE,
      image: merged.image,
      profile: merged.mountProfile,
      shimCommands: merged.shimCommands,
      agentBind: merged.agentBind,
      claudeConfigDir: merged.claudeConfigDir,
    },
    null,
    2,
  ) + '\n',
);
