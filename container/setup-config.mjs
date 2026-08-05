#!/usr/bin/env node
// Builds the container's CLAUDE_CONFIG_DIR out of the host's Claude Code setup.
//
// Two things happen here, and they are the difference between "Claude Code in a
// box" and "Claude Code that knows your machine":
//
//   1. Live linkage. skills / plugins / agents / commands / hooks / memory files
//      are symlinked straight at the host's ~/.claude, so anything you install
//      on the host is instantly visible inside the container.
//   2. MCP rewriting. Locally configured stdio servers are re-pointed at
//      `ccd-mcp <name>`, which runs the real server back on the host — the only
//      way native host binaries and host-only runtimes keep working.
//
// Session state (credentials, transcripts, .claude.json) stays container-side in
// a persistent directory, so a Linux container never fights the host's own
// macOS/Windows install and login survives restarts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const CCD_DIR = process.env.DOCLAUDE_DIR || path.join(os.homedir(), '.cc-docker');
const HOST_CLAUDE_DIR = process.env.DOCLAUDE_HOST_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const HOST_CLAUDE_JSON =
  process.env.DOCLAUDE_HOST_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
const WORKDIR = process.env.DOCLAUDE_WORKDIR || process.cwd();

if (!CONFIG_DIR) {
  console.error('cc-docker: CLAUDE_CONFIG_DIR is not set');
  process.exit(1);
}

const quiet = process.env.DOCLAUDE_QUIET === '1';
const note = (msg) => {
  if (!quiet) process.stderr.write(`cc-docker: ${msg}\n`);
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const config = readJson(path.join(CCD_DIR, 'config.json'), {}) || {};
const linkNames = config.linkFromHost || [
  'skills',
  'plugins',
  'agents',
  'commands',
  'hooks',
  'output-styles',
  'scripts',
  'ide',
];
const settingsMode = config.settingsMode || 'copy'; // copy | link | skip
const mcpPolicy = config.mcpPolicy || {};
const overrides = mcpPolicy.overrides || {};
const stdioDefault = mcpPolicy.stdio || 'host'; // host | container | skip
const remoteDefault = mcpPolicy.remote || 'container'; // container | skip

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. live linkage to the host's ~/.claude
// ---------------------------------------------------------------------------

function link(name) {
  const source = path.join(HOST_CLAUDE_DIR, name);
  const target = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(source)) return false;

  let current = null;
  try {
    current = fs.lstatSync(target);
  } catch {
    /* absent */
  }
  if (current) {
    if (current.isSymbolicLink()) {
      if (fs.readlinkSync(target) === source) return true;
      fs.unlinkSync(target);
    } else {
      note(`${name} exists in the container config and is not a link — leaving it alone`);
      return false;
    }
  }
  fs.symlinkSync(source, target);
  return true;
}

const linked = [];
for (const name of linkNames) if (link(name)) linked.push(name);

// Root-level memory files (CLAUDE.md and whatever it @-imports).
if (fs.existsSync(HOST_CLAUDE_DIR)) {
  for (const entry of fs.readdirSync(HOST_CLAUDE_DIR)) {
    if (entry.endsWith('.md') && link(entry)) linked.push(entry);
  }
}
if (linked.length) note(`linked from host: ${linked.join(', ')}`);

// ---------------------------------------------------------------------------
// 2. settings.json
// ---------------------------------------------------------------------------

const hostSettings = path.join(HOST_CLAUDE_DIR, 'settings.json');
const containerSettings = path.join(CONFIG_DIR, 'settings.json');
if (settingsMode === 'link') {
  link('settings.json');
} else if (settingsMode === 'copy' && fs.existsSync(hostSettings) && !fs.existsSync(containerSettings)) {
  fs.copyFileSync(hostSettings, containerSettings);
  note('seeded settings.json from the host (edit it in ~/.cc-docker/claude/settings.json)');
}

// ---------------------------------------------------------------------------
// 3. MCP servers
// ---------------------------------------------------------------------------

const hostConfig = readJson(HOST_CLAUDE_JSON, {}) || {};

function classify(name, def) {
  if (overrides[name]) return overrides[name];
  const isStdio = def && (def.command || def.type === 'stdio');
  return isStdio ? stdioDefault : remoteDefault;
}

function transform(servers) {
  const out = {};
  const report = [];
  for (const [name, def] of Object.entries(servers || {})) {
    const mode = classify(name, def);
    if (mode === 'skip') {
      report.push(`${name}=skipped`);
      continue;
    }
    if (mode === 'host') {
      out[name] = { type: 'stdio', command: 'ccd-mcp', args: [name] };
      report.push(`${name}=host`);
    } else {
      out[name] = def;
      report.push(`${name}=container`);
    }
  }
  return { out, report };
}

const globals = transform(hostConfig.mcpServers);
const hostProject = (hostConfig.projects || {})[WORKDIR] || {};
const projectServers = transform(hostProject.mcpServers);

// ---------------------------------------------------------------------------
// 4. merge into the container's .claude.json without destroying its state
// ---------------------------------------------------------------------------

const containerJsonPath = path.join(CONFIG_DIR, '.claude.json');
const containerJson = readJson(containerJsonPath, {}) || {};
const firstRun = !fs.existsSync(containerJsonPath);

containerJson.mcpServers = globals.out;

// Carry over identity/onboarding once, so the first container run does not
// replay onboarding for a user who is already set up on the host.
if (firstRun) {
  for (const key of [
    'userID',
    'anonymousId',
    'oauthAccount',
    'hasCompletedOnboarding',
    'lastOnboardingVersion',
    'theme',
    'installMethod',
    'autoUpdates',
    'claudeMaxTier',
    'subscriptionType',
  ]) {
    if (hostConfig[key] !== undefined) containerJson[key] = hostConfig[key];
  }
  containerJson.autoUpdates = false;
}

// Mirror the host's per-project settings for this working directory, including
// whether the user already trusted it — we deliberately copy that decision
// rather than inventing one.
containerJson.projects = containerJson.projects || {};
const existingProject = containerJson.projects[WORKDIR] || {};
const carried = {};
for (const key of [
  'hasTrustDialogAccepted',
  'allowedTools',
  'ignorePatterns',
  'projectOnboardingSeenCount',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
]) {
  if (hostProject[key] !== undefined) carried[key] = hostProject[key];
}
containerJson.projects[WORKDIR] = {
  ...carried,
  ...existingProject,
  mcpServers: projectServers.out,
};

writeJsonAtomic(containerJsonPath, containerJson);

const allReports = [...globals.report, ...projectServers.report];
if (allReports.length) note(`mcp: ${allReports.join(', ')}`);
else note('mcp: no servers configured on the host');
