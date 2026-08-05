// Tests for container/setup-config.mjs — the piece that turns the host's
// Claude Code installation into the container's CLAUDE_CONFIG_DIR.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETUP = path.join(REPO, 'container', 'setup-config.mjs');

function scaffold({ hostClaudeJson = {}, ccdConfig = {}, workdir = '/work/project' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-setup-'));
  const home = path.join(root, 'home');
  const hostClaudeDir = path.join(home, '.claude');
  const ccdDir = path.join(home, '.cc-docker');
  const configDir = path.join(ccdDir, 'claude');

  fs.mkdirSync(path.join(hostClaudeDir, 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(hostClaudeDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(hostClaudeDir, 'agents'), { recursive: true });
  fs.mkdirSync(ccdDir, { recursive: true });
  fs.writeFileSync(path.join(hostClaudeDir, 'CLAUDE.md'), '# host memory\n');
  fs.writeFileSync(path.join(hostClaudeDir, 'skills', 'demo', 'SKILL.md'), '# demo skill\n');
  fs.writeFileSync(
    path.join(hostClaudeDir, 'settings.json'),
    JSON.stringify({ model: 'opus', enabledPlugins: { 'x@y': true } }),
  );
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(hostClaudeJson));
  fs.writeFileSync(path.join(ccdDir, 'config.json'), JSON.stringify(ccdConfig));

  const run = () =>
    spawnSync(process.execPath, [SETUP], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        DOCLAUDE_DIR: ccdDir,
        DOCLAUDE_HOST_CLAUDE_DIR: hostClaudeDir,
        DOCLAUDE_HOST_CLAUDE_JSON: path.join(home, '.claude.json'),
        DOCLAUDE_WORKDIR: workdir,
        DOCLAUDE_QUIET: '1',
      },
    });

  const readResult = () => JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));

  return { root, home, hostClaudeDir, ccdDir, configDir, workdir, run, readResult };
}

test('rewrites stdio MCP servers to the host bridge and leaves remote ones alone', (t) => {
  const env = scaffold({
    hostClaudeJson: {
      mcpServers: {
        native: { type: 'stdio', command: '/opt/homebrew/bin/native-tool', args: ['mcp'] },
        legacy: { command: 'uvx', args: ['some-server'] },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      },
    },
  });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  const result = env.run();
  assert.equal(result.status, 0, result.stderr);

  const config = env.readResult();
  assert.deepEqual(config.mcpServers.native, { type: 'stdio', command: 'ccd-mcp', args: ['native'] });
  assert.deepEqual(config.mcpServers.legacy, { type: 'stdio', command: 'ccd-mcp', args: ['legacy'] });
  assert.deepEqual(config.mcpServers.remote, { type: 'http', url: 'https://mcp.example.com/mcp' });
});

test('honours per-server policy overrides', (t) => {
  const env = scaffold({
    hostClaudeJson: {
      mcpServers: {
        stays: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
        gone: { type: 'stdio', command: 'whatever' },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      },
    },
    ccdConfig: {
      mcpPolicy: {
        stdio: 'host',
        remote: 'container',
        overrides: { stays: 'container', gone: 'skip', remote: 'skip' },
      },
    },
  });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const config = env.readResult();
  assert.deepEqual(config.mcpServers.stays, { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  assert.equal(config.mcpServers.gone, undefined);
  assert.equal(config.mcpServers.remote, undefined);
});

test('carries project-scoped MCP servers for the working directory only', (t) => {
  const env = scaffold({
    workdir: '/work/project',
    hostClaudeJson: {
      projects: {
        '/work/project': { mcpServers: { mine: { type: 'stdio', command: 'tool' } } },
        '/work/other': { mcpServers: { theirs: { type: 'stdio', command: 'tool' } } },
      },
    },
  });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const config = env.readResult();
  assert.deepEqual(config.projects['/work/project'].mcpServers.mine, {
    type: 'stdio',
    command: 'ccd-mcp',
    args: ['mine'],
  });
  assert.equal(config.projects['/work/other'], undefined);
});

test('symlinks skills, plugins and memory files at the host installation', (t) => {
  const env = scaffold();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);

  for (const name of ['skills', 'plugins', 'agents', 'CLAUDE.md']) {
    const link = path.join(env.configDir, name);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} must be a symlink`);
    assert.equal(fs.readlinkSync(link), path.join(env.hostClaudeDir, name));
  }
  // Live linkage means a skill added on the host is visible immediately.
  fs.mkdirSync(path.join(env.hostClaudeDir, 'skills', 'added-later'), { recursive: true });
  assert.ok(fs.existsSync(path.join(env.configDir, 'skills', 'added-later')));
  assert.equal(
    fs.readFileSync(path.join(env.configDir, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    '# demo skill\n',
  );
});

test('seeds settings.json once and then leaves the container copy alone', (t) => {
  const env = scaffold();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const settingsPath = path.join(env.configDir, 'settings.json');
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).model, 'opus');

  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'edited-in-container' }));
  assert.equal(env.run().status, 0);
  assert.equal(
    JSON.parse(fs.readFileSync(settingsPath, 'utf8')).model,
    'edited-in-container',
    'a second run must not clobber container-side edits',
  );
});

test('switching settingsMode to link takes effect over an existing copy', (t) => {
  const env = scaffold();
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const settings = path.join(env.configDir, 'settings.json');
  assert.ok(!fs.lstatSync(settings).isSymbolicLink(), 'copy mode writes a real file');

  // The user asked for linking; silently keeping the copy would ignore them.
  fs.writeFileSync(path.join(env.ccdDir, 'config.json'), JSON.stringify({ settingsMode: 'link' }));
  assert.equal(env.run().status, 0);
  assert.ok(fs.lstatSync(settings).isSymbolicLink(), 'link mode must replace the copy');
  assert.equal(fs.readlinkSync(settings), path.join(env.hostClaudeDir, 'settings.json'));
  assert.ok(fs.existsSync(settings + '.bak'), 'the previous file must be kept, not discarded');
});

test('switching settingsMode back to copy detaches from the host file', (t) => {
  const env = scaffold({ ccdConfig: { settingsMode: 'link' } });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const settings = path.join(env.configDir, 'settings.json');
  assert.ok(fs.lstatSync(settings).isSymbolicLink());

  fs.writeFileSync(path.join(env.ccdDir, 'config.json'), JSON.stringify({ settingsMode: 'copy' }));
  assert.equal(env.run().status, 0);
  assert.ok(!fs.lstatSync(settings).isSymbolicLink(), 'copy mode must stop editing the host file');

  // Editing the container copy must no longer touch the host's settings.
  fs.writeFileSync(settings, JSON.stringify({ model: 'container-only' }));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(env.hostClaudeDir, 'settings.json'), 'utf8')).model,
    'opus',
  );
});

test('preserves container session state across runs', (t) => {
  const env = scaffold({
    hostClaudeJson: {
      userID: 'user-123',
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'someone@example.com' },
      mcpServers: { a: { command: 'x' } },
    },
  });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  let config = env.readResult();
  assert.equal(config.userID, 'user-123');
  assert.equal(config.hasCompletedOnboarding, true);
  assert.equal(config.oauthAccount.emailAddress, 'someone@example.com');

  // Simulate state Claude Code writes during a session.
  config.tipsHistory = { welcome: 3 };
  config.projects[env.workdir].lastSessionId = 'abc';
  fs.writeFileSync(path.join(env.configDir, '.claude.json'), JSON.stringify(config));

  assert.equal(env.run().status, 0);
  config = env.readResult();
  assert.deepEqual(config.tipsHistory, { welcome: 3 }, 'session state must survive a re-run');
  assert.equal(config.projects[env.workdir].lastSessionId, 'abc');
});

test('mirrors the host trust decision for the working directory', (t) => {
  const env = scaffold({
    workdir: '/work/trusted',
    hostClaudeJson: {
      projects: { '/work/trusted': { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls:*)'] } },
    },
  });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const project = env.readResult().projects['/work/trusted'];
  assert.equal(project.hasTrustDialogAccepted, true);
  assert.deepEqual(project.allowedTools, ['Bash(ls:*)']);
});

test('does not invent trust for a directory the host never trusted', (t) => {
  const env = scaffold({ workdir: '/work/untrusted', hostClaudeJson: {} });
  t.after(() => fs.rmSync(env.root, { recursive: true, force: true }));

  assert.equal(env.run().status, 0);
  const project = env.readResult().projects['/work/untrusted'];
  assert.equal(project.hasTrustDialogAccepted, undefined);
});

test('survives a host with no Claude Code installation at all', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-bare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'cfg');

  const result = spawnSync(process.execPath, [SETUP], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_CONFIG_DIR: configDir,
      DOCLAUDE_DIR: path.join(root, '.cc-docker'),
      DOCLAUDE_HOST_CLAUDE_DIR: path.join(root, 'nonexistent'),
      DOCLAUDE_HOST_CLAUDE_JSON: path.join(root, 'nonexistent.json'),
      DOCLAUDE_WORKDIR: root,
      DOCLAUDE_QUIET: '1',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  assert.deepEqual(config.mcpServers, {});
});
