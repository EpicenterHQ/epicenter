/**
 * Verifies consultation and delegation transport and boundaries on new and resumed
 * turns. A fake CLI records stdin and argv; live acceptance checks must separately
 * establish that the installed Claude CLI enforces these restrictions.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launcher = join(import.meta.dir, 'consult-claude.ts');
const sessionId = '12345678-1234-1234-1234-123456789abc';

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'consult-test-')));
	const source = join(root, 'source');
	const bin = join(root, 'bin');
	mkdirSync(source);
	mkdirSync(bin);
	const git = spawnSync('git', ['init', '-q', source]);
	if (git.status !== 0)
		throw new Error('Fixture repository initialization failed.');
	writeFileSync(
		join(bin, 'claude'),
		`#!${process.execPath}
const input = await Bun.stdin.text();
if (process.env.CONSULT_TEST_FAIL) {
  console.error('native failure');
  process.exit(7);
}
console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), input, session_id: '${sessionId}' }));
`,
		{ mode: 0o755 },
	);
	return {
		source,
		root,
		launch(args: string[] = [], input = 'Review this.', fail = false) {
			return spawnSync(process.execPath, [launcher, ...args], {
				cwd: source,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					CONSULT_TEST_FAIL: fail ? '1' : '',
				},
				input,
				encoding: 'utf8',
				timeout: 10_000,
			});
		},
		[Symbol.dispose]() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('new and resumed turns preserve the brief and enforce the same access boundary', () => {
	using fixture = setup();
	const brief =
		'Proposed API:\n```ts\nopen({ value: "$HOME", literal: "`tick`" });\n```\n';
	for (const options of [[], ['--resume', sessionId]]) {
		const result = fixture.launch(options, brief);
		expect(result.status).toBe(0);
		const call = JSON.parse(result.stdout);
		expect(call.cwd).toBe(fixture.source);
		expect(call.input).toBe(brief);
		expect(call.session_id).toBe(sessionId);
		const args: string[] = call.args;
		expect(args).toContain('--print');
		expect(args).toContain('--restricted');
		expect(args).toContain('--strict-mcp-config');
		expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
		expect(args[args.indexOf('--disallowedTools') + 1]).toBe('mcp__*');
		expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
		expect(args[args.indexOf('--output-format') + 1]).toBe('json');
		expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
			disableAllHooks: true,
			permissions: { blockReadsOutsideWorkingDirectories: true },
		});
		expect(args.includes('--resume')).toBe(options.length > 0);
		if (options.length)
			expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
		expect(args).not.toContain('--bg');
		expect(args).not.toContain('--effort');
	}
	expect(readdirSync(fixture.source)).toEqual(['.git']);
});

test('passes selected model and effort and previews without launching Claude', () => {
	using fixture = setup();
	const result = fixture.launch(
		['--model', 'sonnet', '--effort', 'high', '--dry-run'],
		'Brief.',
		true,
	);
	expect(result.status).toBe(0);
	const preview = JSON.parse(result.stdout);
	expect(preview.args[preview.args.indexOf('--model') + 1]).toBe('sonnet');
	expect(preview.args[preview.args.indexOf('--effort') + 1]).toBe('high');
	expect(preview.cwd).toBe(fixture.source);
});

test('forwards native failures without disguising them as a result', () => {
	using fixture = setup();
	const result = fixture.launch([], 'Brief.', true);
	expect(result.status).toBe(7);
	expect(result.stdout).toBe('');
	expect(result.stderr).toContain('native failure');
});

test('rejects empty briefs, malformed session IDs, and obsolete laboratory options', () => {
	using fixture = setup();
	for (const args of [
		['start'],
		['--experiment'],
		['--resume', ''],
		['--resume', 'short-id'],
		['--model', ' '],
		['--effort', ' '],
		['--unknown'],
	]) {
		expect(fixture.launch(args).status).not.toBe(0);
	}
	expect(fixture.launch([], '  ').status).not.toBe(0);
});

test('delegation uses its dedicated clone and reapplies the execution boundary on resume', () => {
	using fixture = setup();
	const workspace = join(fixture.root, 'worker');
	expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
	for (const resume of [[], ['--resume', sessionId]]) {
		const result = fixture.launch([
			'--mode',
			'delegate',
			'--workspace',
			workspace,
			...resume,
		]);
		expect(result.status).toBe(0);
		const call = JSON.parse(result.stdout);
		expect(call.cwd).toBe(workspace);
		const args: string[] = call.args;
		expect(args[args.indexOf('--tools') + 1]).toBe(
			'Read,Glob,Grep,Edit,Write,Bash',
		);
		expect(args[args.indexOf('--allowedTools') + 1]).not.toContain('Bash');
		expect(args).toContain('--restricted');
		expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
		const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
		expect(settings.sandbox).toMatchObject({
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: true,
			allowUnsandboxedCommands: false,
			excludedCommands: [],
			filesystem: { disabled: false },
			network: { allowedDomains: [], allowLocalBinding: false },
		});
		expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
	}
	expect(readdirSync(fixture.source)).toEqual(['.git']);
});

test('refuses execution in the live checkout, nested repositories, shared worktrees and non-repositories', () => {
	using fixture = setup();
	const nested = join(fixture.source, '..nested');
	expect(spawnSync('git', ['init', '-q', nested]).status).toBe(0);
	const unrelated = join(fixture.root, 'not-a-repo');
	mkdirSync(unrelated);
	const git = (args: string[]) =>
		spawnSync('git', args, { cwd: fixture.source });
	writeFileSync(join(fixture.source, 'seed.txt'), 'seed');
	expect(git(['add', 'seed.txt']).status).toBe(0);
	expect(
		git([
			'-c',
			'commit.gpgsign=false',
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'commit',
			'-qm',
			'seed',
		]).status,
	).toBe(0);
	expect(spawnSync('git', ['init', '-q', fixture.root]).status).toBe(0);
	const shared = join(fixture.root, 'shared');
	expect(git(['worktree', 'add', '--detach', shared]).status).toBe(0);
	for (const workspace of [
		fixture.source,
		fixture.root,
		nested,
		unrelated,
		shared,
	]) {
		const result = fixture.launch([
			'--mode',
			'delegate',
			'--workspace',
			workspace,
		]);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
	}
	for (const args of [
		['--mode', 'delegate'],
		['--mode', 'other'],
		['--workspace', shared],
	])
		expect(fixture.launch(args).status).not.toBe(0);
});
