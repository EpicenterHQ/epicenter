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
	const seed = spawnSync('git', [
		'-C',
		source,
		'-c',
		'commit.gpgsign=false',
		'-c',
		'user.name=Fixture',
		'-c',
		'user.email=fixture@example.invalid',
		'commit',
		'--allow-empty',
		'-qm',
		'seed',
	]);
	if (seed.status !== 0) throw new Error('Fixture source commit failed.');
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
		clone() {
			const workspace = join(root, 'worker');
			const clone = spawnSync('git', [
				'clone',
				'--no-local',
				'-q',
				source,
				workspace,
			]);
			if (clone.status !== 0) throw new Error('Fixture clone failed.');
			return workspace;
		},
		launch(args: string[] = [], input = 'Review this.', fail = false) {
			return spawnSync(process.execPath, [launcher, ...args], {
				cwd: source,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					CONSULT_TEST_FAIL: fail ? '1' : '',
					CONSULT_TEST_SECRET: 'harmless-credential-canary',
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
	for (const options of [
		['--model', 'claude-opus-5-5'],
		['--resume', sessionId],
	]) {
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
		expect(args.includes('--model')).toBe(!options.includes('--resume'));
		expect(args.includes('--resume')).toBe(options.includes('--resume'));
		if (options.includes('--resume'))
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

test('new consultations require a deliberate model choice', () => {
	using fixture = setup();
	const result = fixture.launch();
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain('A new consultation requires --model');
	expect(result.stdout).toBe('');
});

test('resume omits launcher defaults and forwards explicit overrides', () => {
	using fixture = setup();
	for (const overrides of [
		[],
		['--model', 'claude-opus-5-5', '--effort', 'high'],
	]) {
		const result = fixture.launch(['--resume', sessionId, ...overrides]);
		expect(result.status).toBe(0);
		const { args } = JSON.parse(result.stdout);
		expect(args.includes('--model')).toBe(overrides.length > 0);
		expect(args.includes('--effort')).toBe(overrides.length > 0);
		if (overrides.length) {
			expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
			expect(args[args.indexOf('--effort') + 1]).toBe('high');
		}
	}
});

test('forwards native failures without disguising them as a result', () => {
	using fixture = setup();
	const result = fixture.launch(['--model', 'claude-opus-5-5'], 'Brief.', true);
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
	expect(fixture.launch(['--model', 'claude-opus-5-5'], '  ').status).not.toBe(
		0,
	);
});

test('delegation verifies source provenance and lets only the sandbox approve Bash', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	const result = fixture.launch([
		'--mode',
		'delegate',
		'--workspace',
		workspace,
	]);
	expect(result.status).toBe(0);
	const call = JSON.parse(result.stdout);
	expect(call.cwd).toBe(workspace);
	const args: string[] = call.args;
	expect(args.includes('--model')).toBe(true);
	expect(args.includes('--effort')).toBe(true);
	expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
	expect(args[args.indexOf('--effort') + 1]).toBe('medium');
	expect(args[args.indexOf('--tools') + 1]).toBe(
		'Read,Glob,Grep,Edit,Write,Bash',
	);
	expect(args[args.indexOf('--allowedTools') + 1]).toBe(
		'Read,Glob,Grep,Edit,Write',
	);
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
	expect(settings.sandbox.credentials.envVars).toContainEqual({
		name: 'CONSULT_TEST_SECRET',
		mode: 'deny',
	});
	expect(settings.sandbox.credentials.envVars).not.toContainEqual({
		name: 'PATH',
		mode: 'deny',
	});
	expect(readdirSync(fixture.source)).toEqual(['.git']);
});

test('delegation passes explicit model and effort choices', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	for (const overrides of [
		['--effort', 'high'],
		['--model', 'claude-opus-5-5', '--effort', 'high'],
	]) {
		const result = fixture.launch([
			'--mode',
			'delegate',
			'--workspace',
			workspace,
			...overrides,
		]);
		expect(result.status).toBe(0);
		const { args } = JSON.parse(result.stdout);
		expect(args[args.indexOf('--effort') + 1]).toBe('high');
		if (overrides.includes('--model'))
			expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
		else expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
	}
});

test('delegation refuses resumed sessions and unrelated live repositories', () => {
	using fixture = setup();
	const worker = fixture.clone();
	const resumed = fixture.launch([
		'--mode',
		'delegate',
		'--workspace',
		worker,
		'--resume',
		sessionId,
	]);
	expect(resumed.status).not.toBe(0);
	expect(resumed.stderr).toContain('Delegation starts a fresh session');
	const sibling = join(fixture.root, 'live-sibling');
	expect(spawnSync('git', ['init', '-q', sibling]).status).toBe(0);
	expect(
		spawnSync('git', [
			'-C',
			sibling,
			'remote',
			'add',
			'origin',
			'https://github.com/example/live',
		]).status,
	).toBe(0);
	const unrelated = fixture.launch([
		'--mode',
		'delegate',
		'--workspace',
		sibling,
	]);
	expect(unrelated.status).not.toBe(0);
	expect(unrelated.stderr).toContain('cloned from the coordinating checkout');
	expect(
		spawnSync('git', ['-C', sibling, 'remote', 'set-url', 'origin', '.'])
			.status,
	).toBe(0);
	const relativeOrigin = fixture.launch([
		'--mode',
		'delegate',
		'--workspace',
		sibling,
	]);
	expect(relativeOrigin.status).not.toBe(0);
	expect(relativeOrigin.stderr).toContain(
		'cloned from the coordinating checkout',
	);
});

test('a linked-worktree coordinator refuses its primary live checkout', () => {
	using fixture = setup();
	const coordinator = join(fixture.root, 'coordinator');
	expect(
		spawnSync('git', [
			'-C',
			fixture.source,
			'worktree',
			'add',
			'--detach',
			coordinator,
		]).status,
	).toBe(0);
	const result = spawnSync(
		process.execPath,
		[
			launcher,
			'--mode',
			'delegate',
			'--workspace',
			fixture.source,
			'--dry-run',
		],
		{
			cwd: coordinator,
			input: 'Do not edit the primary checkout.',
			encoding: 'utf8',
		},
	);
	expect(result.status).not.toBe(0);
	expect(result.stdout).toBe('');
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
