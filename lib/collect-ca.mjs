#!/usr/bin/env node
// Collects the host's extra root certificates into a single PEM bundle.
//
// Networks that inspect TLS (corporate proxies, Zscaler, Netskope, and friends)
// re-sign every connection with a private root. The host trusts it; a fresh
// Debian container does not, so the very first `curl https://…` in the build
// dies with "self-signed certificate in certificate chain".
//
// Rather than make the user hunt for their CA file, look where such roots
// actually live on each platform and merge whatever is there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const outFile = flag('out');
if (!outFile) {
  console.error('usage: collect-ca.mjs --out <bundle.crt> [--ca-file <path>]...');
  process.exit(2);
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const sources = [];

function addFile(file, label) {
  if (!file) return;
  try {
    if (!fs.statSync(file).isFile()) return;
    const text = fs.readFileSync(file, 'utf8');
    const blocks = text.match(PEM_BLOCK);
    if (blocks && blocks.length) sources.push({ label: label || file, blocks });
  } catch {
    /* unreadable or not a file */
  }
}

function addDir(dir, label) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/\.(crt|pem|cer)$/i.test(entry)) addFile(path.join(dir, entry), `${label}: ${entry}`);
  }
}

// 1. Anything the user pointed at explicitly always wins.
for (const file of flagAll('ca-file')) addFile(file, `--ca-file ${file}`);

// 2. The standard "my network intercepts TLS" environment variables. If the
//    user's shell already has one of these, it is exactly the bundle we need.
for (const key of [
  'DOCLAUDE_CA_FILE',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'AWS_CA_BUNDLE',
]) {
  if (process.env[key]) addFile(process.env[key], `$${key}`);
}

// 3. Platform locations where administrators install extra roots.
if (process.platform === 'darwin') {
  // The System keychain is where MDM and corporate installers put their roots.
  // Apple's own public roots live in a different keychain, so this stays small
  // and specific on a normal machine.
  for (const keychain of ['/Library/Keychains/System.keychain']) {
    try {
      const pem = execFileSync('security', ['find-certificate', '-a', '-p', keychain], {
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const blocks = pem.match(PEM_BLOCK);
      if (blocks && blocks.length) sources.push({ label: keychain, blocks });
    } catch {
      /* keychain missing or locked */
    }
  }
} else {
  addDir('/usr/local/share/ca-certificates', 'local CA dir');
  addDir('/etc/pki/ca-trust/source/anchors', 'anchors');
  addDir('/etc/ssl/certs/extra', 'extra');
}

// --- merge, de-duplicating identical certificates ---------------------------

const seen = new Set();
const merged = [];
const used = [];
for (const source of sources) {
  let added = 0;
  for (const block of source.blocks) {
    const normalised = block.replace(/\s+/g, '');
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    merged.push(block.trim());
    added += 1;
  }
  if (added) used.push({ label: source.label, count: added });
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (merged.length === 0) {
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* nothing to clear */
  }
} else {
  fs.writeFileSync(outFile, merged.join('\n') + '\n');
}

process.stdout.write(JSON.stringify({ count: merged.length, outFile, sources: used }, null, 2) + '\n');
