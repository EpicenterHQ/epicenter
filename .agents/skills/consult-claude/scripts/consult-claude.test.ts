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
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const launcher = join(import.meta.dir, 'consult-claude.ts');
const personalAccount = [
	'--account',
	'personal',
	'--account-email',
	'expected@example.com',
];
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
const args = process.argv.slice(2);
const selectedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR|CLAUDE_CODE_SIMPLE|AWS_BEARER_TOKEN_BEDROCK)/.test(key)));
if (process.env.CONSULT_TEST_TRACE) {
  const {appendFileSync} = await import('node:fs');
  appendFileSync(process.env.CONSULT_TEST_TRACE, JSON.stringify({args, env:selectedEnv})+'\\n');
}
if (args.includes('auth')) {
  console.log(process.env.CONSULT_TEST_STATUS || JSON.stringify({loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty', subscriptionType:'max', email:'expected@example.com', configDirectory:process.env.CLAUDE_CONFIG_DIR || '${join(homedir(), '.claude')}'}));
  process.exit(process.env.CONSULT_TEST_STATUS_EXIT ? 1 : 0);
}
const input = await Bun.stdin.text();
if (process.env.CONSULT_TEST_FAIL) {
  console.error('native failure');
  process.exit(7);
}
console.log(JSON.stringify({ cwd: process.cwd(), args, env:selectedEnv, input, session_id: '${sessionId}' }));
`,
		{ mode: 0o755 },
	);
	return {
		source,
		root,
		launch(
			args: string[] = [],
			input = 'Review this.',
			fail = false,
			env: Record<string, string | undefined> = {},
		) {
			return spawnSync(process.execPath, [launcher, ...args], {
				cwd: source,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					CONSULT_TEST_FAIL: fail ? '1' : '',
					...env,
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
		const result = fixture.launch([...personalAccount, ...options], brief);
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

test('both accounts share a sanitized environment across new and resumed consultation and delegation', () => {
	using fixture = setup();
	const workspace = join(fixture.root, 'worker');
	expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
	const trace = join(fixture.root, 'calls.jsonl');
	const overrides = {
		ANTHROPIC_API_KEY: 'secret-key',
		ANTHROPIC_AUTH_TOKEN: 'secret-token',
		ANTHROPIC_BASE_URL: 'https://wrong-provider.invalid',
		CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth',
		CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'secret-refresh',
		CLAUDE_CODE_OAUTH_SCOPES: 'other-scopes',
		CLAUDE_CODE_SIMPLE: '1',
		CLAUDE_CODE_USE_BEDROCK: '1',
		CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong-shared-storage',
		CLAUDE_CONFIG_DIR: '/wrong-profile',
		CONSULT_TEST_TRACE: trace,
	};
	for (const account of ['personal', 'work']) {
		for (const turn of [
			['--model', 'sonnet'],
			['--resume', sessionId],
			['--mode', 'delegate', '--workspace', workspace],
			['--mode', 'delegate', '--workspace', workspace, '--resume', sessionId],
		]) {
			writeFileSync(trace, '');
			const result = fixture.launch(
				[
					'--account',
					account,
					'--account-email',
					'expected@example.com',
					...turn,
				],
				'Brief.',
				false,
				overrides,
			);
			expect(result.status).toBe(0);
			const call = JSON.parse(result.stdout);
			const expectedEnv =
				account === 'personal'
					? {}
					: { CLAUDE_CONFIG_DIR: join(homedir(), '.claude-work') };
			expect(call.env).toEqual(expectedEnv);
			const calls = readFileSync(trace, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
			expect(calls).toHaveLength(2);
			expect(calls[0].args).toContain('auth');
			expect(calls[0].args).toContain('--restricted');
			expect(calls[0].env).toEqual(call.env);
			expect(calls[0].args[calls[0].args.indexOf('--settings') + 1]).toBe(
				call.args[call.args.indexOf('--settings') + 1],
			);
			expect(result.stdout + result.stderr).not.toContain('secret-');
		}
	}
});

test('wrong identity, billing method, provider, missing subscription and invalid status stop before prompt', () => {
	using fixture = setup();
	const trace = join(fixture.root, 'calls.jsonl');
	const status = {
		loggedIn: true,
		authMethod: 'claude.ai',
		apiProvider: 'firstParty',
		subscriptionType: 'max',
		email: 'expected@example.com',
		configDirectory: join(homedir(), '.claude-work'),
	};
	for (const override of [
		{ email: 'other@example.com' },
		{ loggedIn: false },
		{ authMethod: 'api_key' },
		{ apiProvider: 'bedrock' },
		{ subscriptionType: null },
		{ subscriptionType: ['max'] },
		{ configDirectory: '/other/profile' },
	]) {
		writeFileSync(trace, '');
		const result = fixture.launch(
			[
				'--model',
				'sonnet',
				'--account',
				'work',
				'--account-email',
				'expected@example.com',
			],
			'Never send this.',
			false,
			{
				CONSULT_TEST_TRACE: trace,
				CONSULT_TEST_STATUS: JSON.stringify({ ...status, ...override }),
			},
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(readFileSync(trace, 'utf8').trim().split('\n')).toHaveLength(1);
	}
	for (const env of [
		{ CONSULT_TEST_STATUS: 'not-json' },
		{ CONSULT_TEST_STATUS_EXIT: '1' },
	]) {
		expect(
			fixture.launch(
				[
					'--model',
					'sonnet',
					'--account',
					'work',
					'--account-email',
					'expected@example.com',
				],
				'Brief.',
				false,
				env,
			).status,
		).not.toBe(0);
	}
});

test('account preview reveals no credentials, invokes no CLI, and requires identity with valid names', () => {
	using fixture = setup();
	const trace = join(fixture.root, 'calls.jsonl');
	writeFileSync(trace, '');
	const preview = fixture.launch(
		[
			'--model',
			'sonnet',
			'--account',
			'work',
			'--account-email',
			'expected@example.com',
			'--dry-run',
		],
		'Brief.',
		true,
		{ ANTHROPIC_API_KEY: 'secret-key', CONSULT_TEST_TRACE: trace },
	);
	expect(preview.status).toBe(0);
	expect(preview.stdout).not.toContain('secret-key');
	expect(JSON.parse(preview.stdout)).toMatchObject({
		account: 'work',
		configDirectory: join(homedir(), '.claude-work'),
		expectedEmail: 'expected@example.com',
	});
	for (const args of [
		[],
		['--account', 'work'],
		['--account', 'work', '--account-email', ' '],
		['--account', 'other', '--account-email', 'expected@example.com'],
		['--account-email', 'expected@example.com'],
		['--account', '../other', '--account-email', 'expected@example.com'],
	]) {
		expect(
			fixture.launch(['--model', 'sonnet', ...args], 'Brief.', false, {
				CONSULT_TEST_TRACE: trace,
			}).status,
		).not.toBe(0);
	}
	expect(readFileSync(trace, 'utf8')).toBe('');
});

test('passes selected model and effort and previews without launching Claude', () => {
	using fixture = setup();
	const result = fixture.launch(
		[...personalAccount, '--model', 'sonnet', '--effort', 'high', '--dry-run'],
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
	const result = fixture.launch(personalAccount);
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
		const result = fixture.launch([
			...personalAccount,
			'--resume',
			sessionId,
			...overrides,
		]);
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

test('forwards native prompt and resume failures without disguising them as a result', () => {
	using fixture = setup();
	for (const turn of [
		['--model', 'claude-opus-5-5'],
		['--resume', sessionId],
	]) {
		const result = fixture.launch(
			[...personalAccount, ...turn],
			'Brief.',
			true,
		);
		expect(result.status).toBe(7);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('native failure');
	}
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
		expect(fixture.launch([...personalAccount, ...args]).status).not.toBe(0);
	}
	expect(
		fixture.launch([...personalAccount, '--model', 'claude-opus-5-5'], '  ')
			.status,
	).not.toBe(0);
});

test('delegation uses its dedicated clone and reapplies the execution boundary on resume', () => {
	using fixture = setup();
	const workspace = join(fixture.root, 'worker');
	expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
	for (const resume of [[], ['--resume', sessionId]]) {
		const result = fixture.launch([
			...personalAccount,
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
		expect(args.includes('--model')).toBe(resume.length === 0);
		expect(args.includes('--effort')).toBe(resume.length === 0);
		if (!resume.length) {
			expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
			expect(args[args.indexOf('--effort') + 1]).toBe('medium');
		}
		expect(args[args.indexOf('--tools') + 1]).toBe(
			'Read,Glob,Grep,Edit,Write,Bash',
		);
		expect(args[args.indexOf('--allowedTools') + 1]).toBe(
			'Read,Glob,Grep,Edit,Write,Bash',
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
	}
	expect(readdirSync(fixture.source)).toEqual(['.git']);
});

test('delegation overrides defaults and preserves explicit choices on resume', () => {
	using fixture = setup();
	const workspace = join(fixture.root, 'worker');
	expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);
	for (const resume of [[], ['--resume', sessionId]]) {
		for (const overrides of [
			['--effort', 'high'],
			['--model', 'claude-opus-5-5', '--effort', 'high'],
		]) {
			const result = fixture.launch([
				...personalAccount,
				'--mode',
				'delegate',
				'--workspace',
				workspace,
				...resume,
				...overrides,
			]);
			expect(result.status).toBe(0);
			const { args } = JSON.parse(result.stdout);
			expect(args[args.indexOf('--effort') + 1]).toBe('high');
			if (overrides.includes('--model'))
				expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
			else if (!resume.length)
				expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
			else expect(args).not.toContain('--model');
		}
	}
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
			...personalAccount,
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
		expect(fixture.launch([...personalAccount, ...args]).status).not.toBe(0);
});
