// Guards against re-introducing environment variables that silently disable
// Claude Code features inside the image.
//
// Several CLAUDE_CODE_* switches are tested for *presence*, not value: setting
// one to `0` still turns it on. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0`
// once shipped here and made /usage fail with "Failed to load usage data" while
// everything else kept working — a failure mode that is very hard to trace back
// to a Dockerfile line.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');

/** ENV assignments, ignoring comment lines. */
function declaredEnvNames(text) {
  const names = [];
  const lines = text.split('\n').filter((line) => !line.trim().startsWith('#'));
  const body = lines.join('\n').replace(/\\\n/g, ' ');
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*ENV\s+(.*)$/);
    if (!match) continue;
    for (const assignment of match[1].split(/\s+/)) {
      const eq = assignment.indexOf('=');
      if (eq > 0) names.push(assignment.slice(0, eq));
    }
  }
  return names;
}

const PRESENCE_CHECKED = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
];

test('the image declares no presence-checked feature kill switches', () => {
  const declared = declaredEnvNames(dockerfile);
  for (const name of PRESENCE_CHECKED) {
    assert.ok(
      !declared.includes(name),
      `${name} must not be set in the image: Claude Code checks it for presence, so even "=0" disables features`,
    );
  }
});

test('the env parser sees through line continuations', () => {
  const sample = 'ENV A=1 \\\n    B=2\nRUN true\nENV C=3\n';
  assert.deepEqual(declaredEnvNames(sample).sort(), ['A', 'B', 'C']);
});

test('the env parser ignores commented-out declarations', () => {
  const sample = '# ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0\nENV REAL=1\n';
  assert.deepEqual(declaredEnvNames(sample), ['REAL']);
});

test('the intentional switches are still declared', () => {
  const declared = declaredEnvNames(dockerfile);
  assert.ok(declared.includes('DISABLE_AUTOUPDATER'), 'the image is immutable; autoupdate must stay off');
  assert.ok(declared.includes('DOCLAUDE_IN_CONTAINER'));
});
