/**
 * Exercises the consultation launcher as a subprocess against a temporary Git
 * repository. Verifies dirty snapshot isolation, native launch arguments,
 * provenance, and failure behavior without sending a model request.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launcher = join(import.meta.dir, 'consult-claude.ts');

function createFixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'consult-claude-test-')));
	const source = join(root, 'source');
	const bin = join(root, 'bin');
	const runs = join(root, 'runs');
	mkdirSync(source);
	mkdirSync(bin);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_RESEARCH_ROOT: runs };
	function git(args: string[], cwd = source) {
		const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	}
	git(['init', '-q']);
	writeFileSync(join(source, 'tracked.txt'), 'committed');
	writeFileSync(join(source, '.gitignore'), 'ignored.txt\n');
	git(['add', 'tracked.txt', '.gitignore']);
	git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
	writeFileSync(join(bin, 'claude'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync('launch.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
if (process.env.CONSULT_TEST_FAIL) { console.error('fixture launch failure'); process.exit(1); }
console.log('backgrounded · fixture-id · fixture-name');
`, { mode: 0o755 });
	return {
		source,
		runs,
		git,
		launch(args: string[] = [], input = 'Investigate the fixture.', fail = false) {
			return spawnSync(process.execPath, [launcher, 'start', '--name', 'fixture', ...args], {
				cwd: source,
				env: { ...env, CONSULT_TEST_FAIL: fail ? '1' : '' },
				input,
				encoding: 'utf8',
				timeout: 10_000,
			});
		},
		[Symbol.dispose]() { rmSync(root, { recursive: true, force: true }); },
	};
}

test('launches the native session once in an independent snapshot of current work', () => {
	using fixture = createFixture();
	const head = fixture.git(['rev-parse', 'HEAD']);
	writeFileSync(join(fixture.source, 'tracked.txt'), 'working change');
	writeFileSync(join(fixture.source, 'untracked.txt'), 'new file');
	writeFileSync(join(fixture.source, 'ignored.txt'), 'excluded');
	const result = fixture.launch();
	expect(result.status).toBe(0);
	expect(result.stdout).toContain('backgrounded · fixture-id · fixture-name');
	const runPath = join(fixture.runs, 'fixture');
	const record = JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf8'));
	const call = JSON.parse(readFileSync(join(record.replicaPath, 'launch.json'), 'utf8'));
	expect(call.cwd).toBe(record.replicaPath);
	expect(call.args).toContain('--restricted');
	expect(call.args).not.toContain('--agent');
	expect(call.args).not.toContain('--agents');
	expect(call.args[call.args.indexOf('--model') + 1]).toBe('claude-fable-5-1');
	expect(call.args[call.args.indexOf('--bg') + 1]).toBe('Investigate the fixture.');
	expect(call.args.join('\n').match(/Investigate the fixture\./g)).toHaveLength(1);
	expect(record.model).toBe('claude-fable-5-1');
	expect(record.snapshotId).not.toBe('pending');
	expect(fixture.git(['remote'], record.replicaPath)).toBe('');
	expect(fixture.git(['rev-parse', '--git-common-dir'], record.replicaPath)).toBe('.git');
	expect(readFileSync(join(record.replicaPath, 'tracked.txt'), 'utf8')).toBe('working change');
	expect(readFileSync(join(record.replicaPath, 'untracked.txt'), 'utf8')).toBe('new file');
	expect(() => readFileSync(join(record.replicaPath, 'ignored.txt'))).toThrow();
	writeFileSync(join(record.replicaPath, 'tracked.txt'), 'Claude experiment');
	expect(fixture.git(['show', `${record.snapshotId}:tracked.txt`], record.replicaPath)).toBe('working change');
	expect(fixture.git(['show', `${record.snapshotId}:untracked.txt`], record.replicaPath)).toBe('new file');
	expect(fixture.git(['rev-parse', 'refs/consultation/baseline'], record.replicaPath)).toBe(record.snapshotId);
	expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('working change');
	expect(fixture.git(['rev-parse', 'HEAD'])).toBe(head);
	const settings = JSON.parse(readFileSync(join(runPath, 'settings.json'), 'utf8'));
	expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
	expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
	expect(settings.sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true });
});

test('passes a chosen model to Claude without a local model catalog', () => {
	using fixture = createFixture();
	const result = fixture.launch(['--model', 'future-model-id']);
	expect(result.status).toBe(0);
	const runPath = join(fixture.runs, 'fixture');
	const call = JSON.parse(readFileSync(join(runPath, 'replica', 'launch.json'), 'utf8'));
	expect(call.args[call.args.indexOf('--model') + 1]).toBe('future-model-id');
	expect(JSON.parse(readFileSync(join(runPath, 'run.json'), 'utf8')).model).toBe('future-model-id');
});

test('preserves untracked relative and dangling symlinks without pointing into the source checkout', () => {
	using fixture = createFixture();
	symlinkSync('tracked.txt', join(fixture.source, 'relative-link'));
	symlinkSync('missing.txt', join(fixture.source, 'dangling-link'));
	expect(fixture.launch().status).toBe(0);
	const replica = join(fixture.runs, 'fixture', 'replica');
	expect(readlinkSync(join(replica, 'relative-link'))).toBe('tracked.txt');
	expect(readlinkSync(join(replica, 'dangling-link'))).toBe('missing.txt');
	writeFileSync(join(replica, 'tracked.txt'), 'snapshot value');
	expect(readFileSync(join(replica, 'relative-link'), 'utf8')).toBe('snapshot value');
	expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('committed');
});

test('dry-run reports the requested alias without creating a laboratory', () => {
	using fixture = createFixture();
	const result = fixture.launch(['--dry-run', '--model', 'fable']);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout).model).toBe('fable');
	expect(() => readFileSync(join(fixture.runs, 'fixture', 'run.json'))).toThrow();
});

test('captures large tracked changes without overwriting a source file with its patch', () => {
	using fixture = createFixture();
	writeFileSync(join(fixture.source, '.consult-claude.patch'), 'a legitimate source file');
	fixture.git(['add', '.consult-claude.patch']);
	fixture.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'tracked patch file']);
	const largeChange = 'x'.repeat(2 * 1024 * 1024);
	writeFileSync(join(fixture.source, 'tracked.txt'), largeChange);
	expect(fixture.launch().status).toBe(0);
	const replica = join(fixture.runs, 'fixture', 'replica');
	expect(readFileSync(join(replica, 'tracked.txt'), 'utf8')).toBe(largeChange);
	expect(readFileSync(join(replica, '.consult-claude.patch'), 'utf8')).toBe('a legitimate source file');
});

test('refuses an untracked nested repository with an actionable error', () => {
	using fixture = createFixture();
	const nested = join(fixture.source, 'nested');
	mkdirSync(nested);
	fixture.git(['init', '-q'], nested);
	fixture.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'nested'], nested);
	const result = fixture.launch();
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('Untracked directory cannot be snapshotted: nested/');
	expect(() => readFileSync(join(fixture.runs, 'fixture', 'replica', 'launch.json'))).toThrow();
});

test('rejects missing models, empty briefs, and removed lifecycle options before creating a run', () => {
	using fixture = createFixture();
	for (const args of [['--model'], ['--model', ' '], ['--wait'], ['--unknown']]) {
		expect(fixture.launch(args).status).not.toBe(0);
	}
	expect(fixture.launch([], '').status).not.toBe(0);
	expect(() => readFileSync(join(fixture.runs, 'fixture', 'run.json'))).toThrow();
});

test('a launch failure returns immediately and preserves the snapshot and provenance', () => {
	using fixture = createFixture();
	const result = fixture.launch([], 'Investigate failure.', true);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain('fixture launch failure');
	const record = JSON.parse(readFileSync(join(fixture.runs, 'fixture', 'run.json'), 'utf8'));
	expect(record.mission).toBe('Investigate failure.');
	expect(readFileSync(join(record.replicaPath, 'tracked.txt'), 'utf8')).toBe('committed');
});

test('refuses to replace an existing run or its evidence', () => {
	using fixture = createFixture();
	expect(fixture.launch().status).toBe(0);
	const recordPath = join(fixture.runs, 'fixture', 'run.json');
	const before = readFileSync(recordPath, 'utf8');
	expect(fixture.launch([], 'Replace evidence.').status).toBe(1);
	expect(readFileSync(recordPath, 'utf8')).toBe(before);
});
