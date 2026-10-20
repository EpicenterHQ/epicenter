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
const sessionId = '12345678-1234-1234-1234-123456789abc';
const personalAccount = [
	'--account',
	'personal',
	'--account-email',
	'expected@example.com',
];

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
		launch(
			args: string[] = [],
			input = 'Review this.',
			fail = false,
			env: Record<string, string | undefined> = {},
			withAccount = true,
		) {
			return spawnSync(
				process.execPath,
				[launcher, ...(withAccount ? personalAccount : []), ...args],
				{
					cwd: source,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH}`,
						CONSULT_TEST_FAIL: fail ? '1' : '',
						CONSULT_TEST_SECRET: 'harmless-credential-canary',
						...env,
					},
					input,
					encoding: 'utf8',
					timeout: 10_000,
				},
			);
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

test('selected account uses one sanitized environment for status and prompt', () => {
	using fixture = setup();
	const trace = join(fixture.root, 'calls.jsonl');
	const workspace = fixture.clone();
	const inherited = {
		ANTHROPIC_API_KEY: 'secret-key',
		ANTHROPIC_BASE_URL: 'https://wrong-provider.invalid',
		CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth',
		CLAUDE_CONFIG_DIR: '/wrong-profile',
		CONSULT_TEST_TRACE: trace,
	};
	for (const account of ['personal', 'work']) {
		for (const turn of [
			['--model', 'sonnet'],
			['--resume', sessionId],
			['--mode', 'delegate', '--workspace', workspace],
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
				inherited,
				false,
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
			expect(calls[0].env).toEqual(expectedEnv);
			expect(calls[1].env).toEqual(expectedEnv);
			if (turn.includes('delegate') && account === 'work') {
				const settings = JSON.parse(
					call.args[call.args.indexOf('--settings') + 1],
				);
				expect(settings.sandbox.credentials.envVars).toContainEqual({
					name: 'CLAUDE_CONFIG_DIR',
					mode: 'deny',
				});
			}
			expect(result.stdout + result.stderr).not.toContain('secret-');
		}
	}
});

test('wrong account identity or subscription stops before the prompt', () => {
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
				'--account',
				'work',
				'--account-email',
				'expected@example.com',
				'--model',
				'sonnet',
			],
			'Never send this.',
			false,
			{
				CONSULT_TEST_TRACE: trace,
				CONSULT_TEST_STATUS: JSON.stringify({ ...status, ...override }),
			},
			false,
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
		expect(readFileSync(trace, 'utf8').trim().split('\n')).toHaveLength(1);
	}
});

test('invalid or failed account status stops before the prompt', () => {
	using fixture = setup();
	const trace = join(fixture.root, 'calls.jsonl');
	for (const env of [
		{ CONSULT_TEST_STATUS: 'not-json' },
		{ CONSULT_TEST_STATUS_EXIT: '1' },
	]) {
		writeFileSync(trace, '');
		const result = fixture.launch(
			['--model', 'sonnet'],
			'Never send this.',
			false,
			{ ...env, CONSULT_TEST_TRACE: trace },
		);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
		const calls = readFileSync(trace, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toContain('auth');
	}
});

test('account preview requires an identity and invokes no Claude process', () => {
	using fixture = setup();
	const trace = join(fixture.root, 'calls.jsonl');
	writeFileSync(trace, '');
	const preview = fixture.launch(
		[
			'--account',
			'work',
			'--account-email',
			'expected@example.com',
			'--model',
			'sonnet',
			'--dry-run',
		],
		'Brief.',
		false,
		{ ANTHROPIC_API_KEY: 'secret-key', CONSULT_TEST_TRACE: trace },
		false,
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
		['--account', '../other', '--account-email', 'expected@example.com'],
		['--account-email', 'expected@example.com'],
	]) {
		expect(
			fixture.launch(
				['--model', 'sonnet', ...args],
				'Brief.',
				false,
				{
					CONSULT_TEST_TRACE: trace,
				},
				false,
			).status,
		).not.toBe(0);
	}
	expect(readFileSync(trace, 'utf8')).toBe('');
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

test('forwards native prompt and resume failures without disguising them as a result', () => {
	using fixture = setup();
	for (const turn of [
		['--model', 'claude-opus-5-5'],
		['--resume', sessionId],
	]) {
		const result = fixture.launch(turn, 'Brief.', true);
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
		expect(fixture.launch(args).status).toBe(1);
	}
	expect(fixture.launch(['--model', 'claude-opus-5-5'], '  ').status).toBe(1);
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
	const unrelated = realpathSync(
		mkdtempSync(join(tmpdir(), 'consult-no-repo-')),
	);
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
	for (const workspace of [fixture.source, fixture.root, nested, shared]) {
		const result = fixture.launch([
			'--mode',
			'delegate',
			'--workspace',
			workspace,
		]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
	}
	try {
		const result = fixture.launch([
			'--mode',
			'delegate',
			'--workspace',
			unrelated,
		]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Delegate workspace must be a Git clone.');
	} finally {
		rmSync(unrelated, { recursive: true, force: true });
	}
	for (const args of [
		['--mode', 'delegate'],
		['--mode', 'other'],
		['--workspace', shared],
	])
		expect(fixture.launch(args).status).toBe(1);
});
