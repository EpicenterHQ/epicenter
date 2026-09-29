/**
 * PROTOTYPE: compare whole-branch Git integration with conditional record uploads.
 * Run: bun packages/data/prototypes/git-sync-prototype.mjs
 * Scratch repositories are created under the system temp directory and removed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const path = 'notes/one.md';
const otherPath = 'notes/two.md';
const initial = note('Base title', 'base-tag', 'Base body');
function parts(bytes) {
  const delimiter = bytes.indexOf('\n---\n', 4);
  if (!bytes.startsWith('---\n') || delimiter < 0) throw new Error('prototype fixture is not frontmatter');
  const fields = Object.fromEntries(bytes.slice(4, delimiter).split('\n').map((line) => {
    const colon = line.indexOf(': ');
    if (colon < 0) throw new Error('prototype supports only simple scalar frontmatter');
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
  return { ...fields, body: bytes.slice(delimiter + 5) };
}
function combine(base, ours, theirs) {
  const old = parts(base), left = parts(ours), right = parts(theirs);
  const merged = {};
  for (const key of new Set([...Object.keys(old), ...Object.keys(left), ...Object.keys(right)])) {
    if (left[key] !== old[key] && right[key] !== old[key] && left[key] !== right[key]) return null;
    merged[key] = left[key] !== old[key] ? left[key] : right[key];
  }
  return `---\n${Object.entries(merged).filter(([key]) => key !== 'body').map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${merged.body}`;
}

if (process.argv[2] === '--merge-driver') {
  const [basePath, oursPath, theirsPath] = process.argv.slice(3);
  const [base, ours, theirs] = [basePath, oursPath, theirsPath].map((name) => readFileSync(name, 'utf8'));
  const merged = combine(base, ours, theirs);
  if (merged === null) process.exit(1);
  writeFileSync(oursPath, merged);
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'epicenter-git-sync-'));

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Prototype', GIT_AUTHOR_EMAIL: 'prototype@example.test', GIT_COMMITTER_NAME: 'Prototype', GIT_COMMITTER_EMAIL: 'prototype@example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function attempt(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Prototype', GIT_AUTHOR_EMAIL: 'prototype@example.test', GIT_COMMITTER_NAME: 'Prototype', GIT_COMMITTER_EMAIL: 'prototype@example.test' } });
  return { ok: result.status === 0, message: (result.stderr || result.stdout).trim().split('\n').at(-1) };
}
function note(title, tag, body) { return `---\ntitle: ${title}\ntag: ${tag}\n---\n${body}\n`; }
function file(dir, name = path) { const target = join(dir, name); return existsSync(target) ? readFileSync(target, 'utf8') : null; }
function put(dir, bytes, name = path) { const target = join(dir, name); mkdirSync(join(dir, 'notes'), { recursive: true }); if (bytes === null) rmSync(target, { force: true }); else writeFileSync(target, bytes); }
function commit(dir, message) { git(dir, 'add', '--all'); git(dir, 'commit', '-m', message); }
function head(dir) { return git(dir, 'rev-parse', '--short=8', 'HEAD'); }
function show(label, repos, extra = '') {
  console.log(`\n${label}${extra ? ` | ${extra}` : ''}`);
  for (const [name, dir] of Object.entries(repos)) {
    const bytes = file(dir);
    console.log(`  ${name} ${head(dir)} ${path}=${JSON.stringify(bytes)} ${otherPath}=${JSON.stringify(file(dir, otherPath))}`);
  }
}
function fixture(name) {
  const dir = join(root, name); mkdirSync(dir);
  const remote = join(dir, 'remote.git'); git(dir, 'init', '--bare', '-q', remote);
  const seed = join(dir, 'seed'); git(dir, 'clone', '-q', remote, seed);
  git(seed, 'switch', '-q', '-c', 'main'); put(seed, initial);
  writeFileSync(join(seed, '.gitattributes'), '*.md -text merge=markdown\n');
  commit(seed, 'initial'); git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const repos = {};
  for (const name of ['a', 'b', 'integrator']) {
    const place = join(dir, name); git(dir, 'clone', '-q', remote, place); repos[name] = place;
    git(place, 'config', 'merge.markdown.driver', `bun ${new URL(import.meta.url).pathname} --merge-driver %O %A %B`);
    if (name !== 'integrator') { git(place, 'switch', '-q', '-c', `device/${name}`); git(place, 'push', '-q', '-u', 'origin', `device/${name}`); }
  }
  return repos;
}
function upload(repos, who) { git(repos[who], 'push', '-q', 'origin', `device/${who}`); }
function integrate(repos, who) {
  const dir = repos.integrator;
  git(dir, 'fetch', '-q', 'origin', `device/${who}:refs/remotes/origin/device/${who}`);
  const bases = git(dir, 'merge-base', '--all', 'main', `origin/device/${who}`).split('\n');
  const before = head(dir);
  const result = attempt(dir, 'merge', '--no-ff', '--no-edit', `origin/device/${who}`);
  if (!result.ok) git(dir, 'merge', '--abort');
  else git(dir, 'push', '-q', 'origin', 'main');
  if (!result.ok) assert.equal(head(dir), before, 'a conflict must not move accepted main');
  return { integrated: result.ok, mergeBases: bases.length, message: result.message };
}
function refresh(repos, who) { git(repos[who], 'fetch', '-q', 'origin', 'main'); const result = attempt(repos[who], 'merge', '--no-ff', '--no-edit', 'origin/main'); if (!result.ok) git(repos[who], 'merge', '--abort'); return result.ok; }

// A separate conditional-upload model, with one revision per record and a local base.
function recordModel() {
  const server = new Map([[path, { rev: 1, bytes: initial }]]);
  const clients = { a: new Map([[path, { base: 1, baseBytes: initial, bytes: initial }]]), b: new Map([[path, { base: 1, baseBytes: initial, bytes: initial }]]) };
  const conflicts = new Map();
  function edit(who, name, bytes) { const current = clients[who].get(name) ?? { base: 0, baseBytes: null, bytes: null }; clients[who].set(name, { ...current, bytes }); }
  function upload(who, name) {
    const local = clients[who].get(name); const remote = server.get(name) ?? { rev: 0, bytes: null };
    if (local.base === remote.rev) {
      server.set(name, { rev: remote.rev + 1, bytes: local.bytes });
      clients[who].set(name, { base: remote.rev + 1, baseBytes: local.bytes, bytes: local.bytes });
      return 'accepted';
    }
    if (local.baseBytes === null || local.bytes === null || remote.bytes === null) {
      conflicts.set(`${who}:${name}`, { local: local.bytes, remote: remote.bytes });
      return 'conflict: delete/edit or missing base';
    }
    const bytes = combine(local.baseBytes, local.bytes, remote.bytes);
    if (bytes === null) {
      conflicts.set(`${who}:${name}`, { local: local.bytes, remote: remote.bytes });
      return 'conflict: overlapping field; both versions retained';
    }
    server.set(name, { rev: remote.rev + 1, bytes }); clients[who].set(name, { base: remote.rev + 1, baseBytes: bytes, bytes });
    return 'merged';
  }
  function showRecord(label, extra = '') {
    console.log(`\n${label}${extra ? ` | ${extra}` : ''}`);
    for (const name of [path, otherPath]) {
      const remote = server.get(name); console.log(`  server r${remote?.rev ?? 0} ${name}=${JSON.stringify(remote?.bytes ?? null)}`);
      for (const who of ['a', 'b']) { const local = clients[who].get(name); console.log(`  ${who} base=${local?.base ?? 0} ${name}=${JSON.stringify(local?.bytes ?? null)} conflict=${JSON.stringify(conflicts.get(`${who}:${name}`) ?? null)}`); }
    }
  }
  return { server, clients, conflicts, edit, upload, showRecord };
}

try {
  console.log('STRICT GIT: one branch per device; integrator merges complete branch');
  {
    const r = fixture('fields'); show('offline initial', r);
    put(r.a, note('A title', 'base-tag', 'Base body')); commit(r.a, 'a edits title');
    put(r.b, note('Base title', 'b-tag', 'Base body')); commit(r.b, 'b edits tag'); show('offline field edits', r);
    upload(r, 'a'); upload(r, 'b');
    const ia = integrate(r, 'a'), ib = integrate(r, 'b'); assert(ia.integrated && ib.integrated); assert.equal(file(r.integrator), note('A title', 'b-tag', 'Base body')); show('integrate separate fields', r, JSON.stringify({ ia, ib }));
    const ra = refresh(r, 'a'), rb = refresh(r, 'b'); assert(ra && rb); assert(file(r.a) === file(r.b) && file(r.a) === file(r.integrator)); show('devices fetch merged main', r, JSON.stringify({ ra, rb, equalBytes: file(r.a) === file(r.b) && file(r.a) === file(r.integrator) }));
    put(r.a, note('A title', 'b-tag', 'A later body')); commit(r.a, 'a second cycle'); upload(r, 'a');
    show('second integration cycle', r, JSON.stringify(integrate(r, 'a')));
    const fresh = join(root, 'fields', 'fresh'); git(join(root, 'fields'), 'clone', '-q', join(root, 'fields', 'remote.git'), fresh); show('fresh device recovers main', { ...r, fresh });
  }
  {
    const r = fixture('multiple-bases');
    put(r.b, note('Base title', 'base-tag', 'Base body'), otherPath); commit(r.b, 'b independent note'); upload(r, 'b'); integrate(r, 'b'); // N
    put(r.a, note('A title', 'base-tag', 'Base body')); commit(r.a, 'a edits first note'); upload(r, 'a'); // D
    git(r.a, 'fetch', '-q', 'origin', 'main'); // A has N but has not merged it.
    integrate(r, 'a'); // Integrator makes I = merge(N, D).
    git(r.a, 'merge', '--no-ff', '--no-edit', 'origin/main'); // A makes R = merge(D, N).
    upload(r, 'a');
    git(r.integrator, 'fetch', '-q', 'origin', 'device/a');
    const allBases = git(r.integrator, 'merge-base', '--all', 'main', 'origin/device/a').split('\n');
    assert.equal(allBases.length, 2); show('concurrent merges create multiple best merge bases', r, JSON.stringify({ mergeBases: allBases.length, baseCommits: allBases.map((oid) => oid.slice(0, 8)) }));
  }
  {
    const r = fixture('body');
    put(r.a, note('Base title', 'base-tag', 'A body')); commit(r.a, 'a edits body'); upload(r, 'a'); integrate(r, 'a');
    put(r.b, note('Base title', 'base-tag', 'B body')); commit(r.b, 'b edits body'); upload(r, 'b');
    const conflict = integrate(r, 'b'); assert.equal(conflict.integrated, false); show('overlapping body waits', r, JSON.stringify(conflict));
    put(r.b, note('Base title', 'base-tag', 'B body'), otherPath); commit(r.b, 'b keeps editing another record'); upload(r, 'b');
    const stillBlocked = integrate(r, 'b'); assert.equal(stillBlocked.integrated, false); assert.equal(file(r.integrator, otherPath), null); show('continued edits stay on blocked branch', r, JSON.stringify(stillBlocked));
    const fresh = join(root, 'body', 'fresh'); git(join(root, 'body'), 'clone', '-q', join(root, 'body', 'remote.git'), fresh);
    const pending = git(fresh, 'show', 'origin/device/b:notes/one.md'); assert(pending.includes('B body'));
    assert(git(fresh, 'show', 'origin/device/b:notes/two.md').includes('B body'));
    show('fresh clone sees accepted main and pending device branch', { ...r, fresh }, JSON.stringify({ pendingBranch: 'origin/device/b', pendingBody: pending }));
    const a = join(root, 'body', 'a'); put(a, note('Base title', 'base-tag', 'A body'), otherPath); commit(a, 'a adds separate record'); upload(r, 'a');
    show('other device can integrate', r, JSON.stringify(integrate(r, 'a')));
  }
  {
    const r = fixture('delete');
    put(r.a, null); commit(r.a, 'a deletes'); upload(r, 'a'); integrate(r, 'a');
    put(r.b, note('Base title', 'base-tag', 'B body')); commit(r.b, 'b edits deleted record'); upload(r, 'b');
    const result = integrate(r, 'b'); assert.equal(result.integrated, false); show('edit versus delete waits', r, JSON.stringify(result));
  }
  {
    const r = fixture('push');
    const stale = join(root, 'push', 'stale-a'); git(join(root, 'push'), 'clone', '-q', join(root, 'push', 'remote.git'), stale); git(stale, 'switch', '-q', 'device/a');
    put(r.a, note('First', 'base-tag', 'Base body')); commit(r.a, 'first writer'); upload(r, 'a');
    put(stale, note('Stale', 'base-tag', 'Base body')); commit(stale, 'stale writer');
    const result = attempt(stale, 'push', 'origin', 'device/a'); assert.equal(result.ok, false); show('concurrent same-branch push rejected', { ...r, stale }, JSON.stringify(result));
  }
  console.log('\nGIT VARIANT: devices merge main; remote advances main by fast-forward only');
  {
    const r = fixture('fast-forward');
    put(r.a, note('A title', 'base-tag', 'Base body')); commit(r.a, 'a edits title'); upload(r, 'a');
    put(r.b, note('Base title', 'b-tag', 'Base body')); commit(r.b, 'b edits tag'); upload(r, 'b');
    const first = attempt(r.a, 'push', 'origin', 'HEAD:main'); assert(first.ok);
    const rejected = attempt(r.b, 'push', 'origin', 'HEAD:main'); assert.equal(rejected.ok, false);
    git(r.b, 'fetch', '-q', 'origin', 'main'); const merged = attempt(r.b, 'merge', '--no-ff', '--no-edit', 'origin/main'); assert(merged.ok);
    upload(r, 'b'); const second = attempt(r.b, 'push', 'origin', 'HEAD:main'); assert(second.ok);
    git(r.integrator, 'fetch', '-q', 'origin'); git(r.a, 'fetch', '-q', 'origin');
    const bases = git(r.a, 'merge-base', '--all', 'HEAD', 'origin/main').split('\n'); assert.equal(bases.length, 1);
    show('stale main push rejected, device merged and fast-forwarded main', r, JSON.stringify({ first: first.ok, rejected: rejected.ok, merged: merged.ok, second: second.ok, mergeBases: bases.length, mainBytes: git(r.integrator, 'show', 'origin/main:notes/one.md') }));
  }
  {
    const r = fixture('fast-forward-conflict');
    put(r.a, note('Base title', 'base-tag', 'A body')); commit(r.a, 'a body'); upload(r, 'a'); assert(attempt(r.a, 'push', 'origin', 'HEAD:main').ok);
    put(r.b, note('Base title', 'base-tag', 'B body')); commit(r.b, 'b body'); upload(r, 'b');
    git(r.b, 'fetch', '-q', 'origin', 'main'); const conflict = attempt(r.b, 'merge', '--no-ff', '--no-edit', 'origin/main'); assert.equal(conflict.ok, false); git(r.b, 'merge', '--abort');
    put(r.b, note('Second', 'tag', 'B keeps editing'), otherPath); commit(r.b, 'b another note'); upload(r, 'b');
    git(r.integrator, 'fetch', '-q', 'origin');
    show('device conflict pauses main but branch retains later edit', r, JSON.stringify({ conflict: !conflict.ok, acceptedMain: git(r.integrator, 'show', 'origin/main:notes/one.md'), deviceBranch: git(r.b, 'rev-parse', '--short=8', 'HEAD') }));
  }
  console.log('\nPER-RECORD: conditional revision upload with field merge');
  {
    const m = recordModel(); m.edit('a', path, note('A title', 'base-tag', 'Base body')); m.edit('b', path, note('Base title', 'b-tag', 'Base body'));
    m.showRecord('offline field edits'); m.showRecord('conditional uploads', `${m.upload('a', path)}, ${m.upload('b', path)}`);
    m.clients.b.set(path, { base: m.server.get(path).rev, baseBytes: m.server.get(path).bytes, bytes: m.server.get(path).bytes }); m.clients.a.set(path, { base: m.server.get(path).rev, baseBytes: m.server.get(path).bytes, bytes: m.server.get(path).bytes }); m.showRecord('replicas download canonical bytes');
    console.log(`  equalBytes=${m.clients.a.get(path).bytes === m.clients.b.get(path).bytes}`);
    console.log(`  fresh device=${JSON.stringify([...m.server])}`);
  }
  {
    const m = recordModel(); m.edit('a', path, note('Base title', 'base-tag', 'A body')); m.edit('b', path, note('Base title', 'base-tag', 'B body'));
    m.upload('a', path); m.showRecord('overlapping body', m.upload('b', path));
    m.edit('b', otherPath, note('Second', 'tag', 'New body')); m.showRecord('independent edit uploads during body conflict', m.upload('b', otherPath));
  }
  {
    const m = recordModel(); m.edit('a', path, null); m.edit('b', path, note('Base title', 'base-tag', 'B body'));
    m.upload('a', path); m.showRecord('edit versus delete', m.upload('b', path));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
