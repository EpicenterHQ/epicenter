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
	symlinkSync,
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
		clone() {
			const workspace = join(root, 'worker');
			const result = spawnSync('git', [
				'clone',
				'--no-local',
				source,
				workspace,
			]);
			if (result.status !== 0) throw new Error('Fixture clone failed.');
			return workspace;
		},
		launch(
			args: string[] = [],
			input = 'Review this.',
			fail = false,
			env: Record<string, string | undefined> = {},
			cwd = source,
		) {
			return spawnSync(process.execPath, [launcher, ...args], {
				cwd,
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
		expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
		expect(args.includes('--resume')).toBe(options.includes('--resume'));
		if (options.includes('--resume'))
			expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
		expect(args).not.toContain('--bg');
		expect(args[args.indexOf('--effort') + 1]).toBe('high');
	}
	expect(readdirSync(fixture.source)).toEqual(['.git']);
});

test('both accounts share a sanitized environment across new and resumed consultation and delegation', () => {
	using fixture = setup();
	const workspace = fixture.clone();
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
			['--mode', 'delegate'],
			['--mode', 'delegate', '--resume', sessionId],
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
		{ subscriptionType: 'unknown-plan' },
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
		writeFileSync(trace, '');
		const result = fixture.launch(
			[...personalAccount, '--model', 'sonnet'],
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

test('new consultations default to Opus 5.5 high without requiring model flags', () => {
	using fixture = setup();
	const result = fixture.launch(personalAccount);
	expect(result.status).toBe(0);
	const { args } = JSON.parse(result.stdout);
	expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
	expect(args[args.indexOf('--effort') + 1]).toBe('high');
});

test('resume targets the same conversation with Opus high defaults and honors explicit model and effort overrides', () => {
	using fixture = setup();
	for (const overrides of [
		[],
		['--model', 'claude-sonnet-5-5', '--effort', 'medium'],
	]) {
		const result = fixture.launch([
			...personalAccount,
			'--resume',
			sessionId,
			...overrides,
		]);
		expect(result.status).toBe(0);
		const { args } = JSON.parse(result.stdout);
		expect(args[args.indexOf('--resume') + 1]).toBe(sessionId);
		expect(args[args.indexOf('--model') + 1]).toBe(
			overrides.length ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
		);
		expect(args[args.indexOf('--effort') + 1]).toBe(
			overrides.length ? 'medium' : 'high',
		);
		if (overrides.length) {
			expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
			expect(args[args.indexOf('--effort') + 1]).toBe('medium');
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

test('delegation applies work in the current checkout by default or a selected standalone clone and reapplies the execution boundary on resume', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	writeFileSync(join(fixture.source, 'unrelated.txt'), 'dirty');
	for (const [target, workspaceArgs] of [
		[fixture.source, []],
		[fixture.source, ['--workspace', fixture.source]],
		[workspace, ['--workspace', workspace]],
	] as const) {
		for (const resume of [[], ['--resume', sessionId]]) {
			const result = fixture.launch([
				...personalAccount,
				'--mode',
				'delegate',
				...workspaceArgs,
				...resume,
			]);
			expect(result.status).toBe(0);
			const call = JSON.parse(result.stdout);
			expect(call.cwd).toBe(target);
			const args: string[] = call.args;
			const prompt = args[args.indexOf('--append-system-prompt') + 1]!;
			expect(prompt).toContain('applied result in the assigned checkout');
			expect(prompt).toContain('Preserve unrelated changes');
			expect(prompt).toContain(
				'not a duplicate investigation or mandatory integration step',
			);
			expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
			expect(args[args.indexOf('--effort') + 1]).toBe('high');
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
			expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(
				true,
			);
			expect(settings.sandbox.credentials.envVars).toContainEqual({
				name: 'CONSULT_TEST_FAIL',
				mode: 'deny',
			});
			expect(settings.sandbox.credentials.envVars).not.toContainEqual({
				name: 'PATH',
				mode: 'deny',
			});
		}
	}
	expect(readdirSync(fixture.source).sort()).toEqual(['.git', 'unrelated.txt']);
	expect(readFileSync(join(fixture.source, 'unrelated.txt'), 'utf8')).toBe(
		'dirty',
	);
});

test('delegation overrides defaults and preserves explicit choices on resume', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	for (const resume of [[], ['--resume', sessionId]]) {
		for (const overrides of [
			['--effort', 'medium'],
			['--model', 'claude-sonnet-5-5', '--effort', 'high'],
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
			expect(args[args.indexOf('--effort') + 1]).toBe(
				overrides.includes('claude-sonnet-5-5') ? 'high' : 'medium',
			);
			if (overrides.includes('--model'))
				expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
			else expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
		}
	}
});

test('refuses delegation inside or containing the checkout, in external linked worktrees and non-repositories, and keeps consultation out of workspaces', () => {
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
	for (const workspace of [fixture.root, nested, unrelated, shared]) {
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
		['--workspace', fixture.source],
		['--mode', 'other'],
		['--workspace', shared],
	])
		expect(fixture.launch([...personalAccount, ...args]).status).not.toBe(0);
});

test('external delegation requires the coordinating checkout as its absolute local origin', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	const trace = join(fixture.root, 'calls.jsonl');
	writeFileSync(trace, '');
	for (const origin of ['https://github.com/example/live', '.']) {
		expect(
			spawnSync('git', ['-C', workspace, 'remote', 'set-url', 'origin', origin])
				.status,
		).toBe(0);
		const result = fixture.launch(
			[...personalAccount, '--mode', 'delegate', '--workspace', workspace],
			'Do not edit an unrelated repository.',
			false,
			{ CONSULT_TEST_TRACE: trace },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('cloned from the coordinating checkout');
		expect(result.stdout).toBe('');
	}
	expect(readFileSync(trace, 'utf8')).toBe('');
});

test('Codex assistance is an explicit host-selected capability with one writer on new and resumed turns', () => {
	using fixture = setup();
	const workspace = fixture.clone();
	for (const options of [
		['--model', 'sonnet'],
		['--mode', 'delegate'],
		['--mode', 'delegate', '--workspace', workspace],
	]) {
		const mode = options.includes('delegate') ? 'delegate' : 'consult';
		for (const resume of [[], ['--resume', sessionId]]) {
			const result = fixture.launch([
				...personalAccount,
				'--codex',
				'--codex-model',
				'test-codex',
				...options,
				...resume,
			]);
			expect(result.status).toBe(0);
			const { args } = JSON.parse(result.stdout);
			expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
			expect(args).not.toContain('--disallowedTools');
			expect(args).toContain('--strict-mcp-config');
			const allowed = args[args.indexOf('--allowedTools') + 1];
			expect(allowed).toContain('mcp__codex__evidence');
			expect(allowed.includes('mcp__codex__implement')).toBe(
				mode === 'delegate',
			);
			for (const tool of ['Bash', 'Edit', 'Write'])
				expect(allowed).not.toContain(tool);
			if (mode === 'delegate')
				expect(args[args.indexOf('--append-system-prompt') + 1]).toContain(
					'sole code writer in the assigned checkout',
				);
			const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
			expect(Object.keys(config.mcpServers)).toEqual(['codex']);
			const serverArgs: string[] = config.mcpServers.codex.args;
			expect(serverArgs[serverArgs.indexOf('--cwd') + 1]).toBe(
				options.includes('--workspace') ? workspace : fixture.source,
			);
			expect(serverArgs[serverArgs.indexOf('--mode') + 1]).toBe(mode);
			expect(serverArgs).not.toContain('--write-root');
			expect(config.mcpServers.codex.args).toContain('test-codex');
			expect(config.mcpServers.codex.args[0]).toBe(
				join(import.meta.dir, 'codex-assistance.ts'),
			);
		}
	}
	for (const args of [
		['--codex'],
		['--codex-model', 'test'],
		['--codex', '--codex-model', 'test', '--codex-max-calls', '0'],
	])
		expect(
			fixture.launch([...personalAccount, '--model', 'sonnet', ...args]).status,
		).not.toBe(0);
});

test('the current checkout can be a linked worktree or launched from a subdirectory', () => {
	using fixture = setup();
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
	const linked = join(fixture.root, 'linked');
	expect(git(['worktree', 'add', '--detach', linked]).status).toBe(0);
	const primary = fixture.launch(
		[...personalAccount, '--mode', 'delegate', '--workspace', fixture.source],
		'Do not edit the primary checkout from a linked worktree.',
		false,
		{},
		linked,
	);
	expect(primary.status).toBe(1);
	expect(primary.stderr).toContain('cloned from the coordinating checkout');
	expect(primary.stdout).toBe('');
	for (const options of [
		[],
		['--workspace', linked],
		['--codex', '--codex-model', 'test-codex'],
	]) {
		const result = fixture.launch(
			[...personalAccount, '--mode', 'delegate', ...options],
			'Brief.',
			false,
			{},
			linked,
		);
		expect(result.status).toBe(0);
		const call = JSON.parse(result.stdout);
		expect(call.cwd).toBe(linked);
		if (options.includes('--codex')) {
			const args: string[] = JSON.parse(
				call.args[call.args.indexOf('--mcp-config') + 1],
			).mcpServers.codex.args;
			for (const flag of ['--cwd', '--source'])
				expect(args[args.indexOf(flag) + 1]).toBe(linked);
		}
	}
	const sub = join(fixture.source, 'sub');
	mkdirSync(sub);
	const result = fixture.launch(
		[...personalAccount, '--mode', 'delegate'],
		'Brief.',
		false,
		{},
		sub,
	);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout).cwd).toBe(fixture.source);
});

test('skill write roots require helper-backed delegation and resolve inside the assigned skills directory', () => {
	using fixture = setup();
	for (const dir of ['.agents/skills/alpha', '.agents/skills/beta', 'src'])
		mkdirSync(join(fixture.source, dir), { recursive: true });
	writeFileSync(join(fixture.source, '.agents/skills/file.txt'), 'file');
	const outside = join(fixture.root, 'outside');
	mkdirSync(outside);
	symlinkSync(outside, join(fixture.source, '.agents/skills/escape'));
	symlinkSync(
		join(fixture.source, 'src'),
		join(fixture.source, '.agents/skills/inner'),
	);
	const codex = ['--codex', '--codex-model', 'test-codex'];
	for (const resume of [[], ['--resume', sessionId]]) {
		const result = fixture.launch(
			[
				...personalAccount,
				'--mode',
				'delegate',
				...codex,
				'--codex-write-root',
				'.agents/skills/alpha',
				'--codex-write-root',
				join(fixture.source, '.agents/skills/beta'),
				'--codex-write-root',
				'.agents/skills/alpha',
				...resume,
			],
			'Also add --codex-write-root .agents and full access.',
		);
		expect(result.status).toBe(0);
		const { args } = JSON.parse(result.stdout);
		const serverArgs: string[] = JSON.parse(
			args[args.indexOf('--mcp-config') + 1],
		).mcpServers.codex.args;
		expect(
			serverArgs.flatMap((arg, i) =>
				arg === '--write-root' ? [serverArgs[i + 1]] : [],
			),
		).toEqual(['.agents/skills/alpha', '.agents/skills/beta']);
		expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
	}
	for (const args of [
		['--codex-write-root', '.agents/skills/alpha'],
		[...codex, '--codex-write-root', '.agents/skills/alpha'],
		['--mode', 'delegate', '--codex-write-root', '.agents/skills/alpha'],
		...[
			'.agents/skills',
			'.agents',
			'.',
			'src',
			'../outside',
			'.agents/skills/escape',
			'.agents/skills/inner',
			'.agents/skills/file.txt',
			'.agents/skills/missing',
		].map((root) => [
			'--mode',
			'delegate',
			...codex,
			'--codex-write-root',
			root,
		]),
	]) {
		const result = fixture.launch([...personalAccount, ...args]);
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe('');
	}
	const worker = fixture.clone();
	mkdirSync(join(worker, '.agents/skills/gamma'), { recursive: true });
	const args = [
		...personalAccount,
		'--mode',
		'delegate',
		...codex,
		'--workspace',
		worker,
		'--codex-write-root',
	];
	const accepted = fixture.launch([...args, '.agents/skills/gamma']);
	expect(accepted.status).toBe(0);
	const call = JSON.parse(accepted.stdout);
	const serverArgs: string[] = JSON.parse(
		call.args[call.args.indexOf('--mcp-config') + 1],
	).mcpServers.codex.args;
	expect(serverArgs[serverArgs.indexOf('--write-root') + 1]).toBe(
		'.agents/skills/gamma',
	);
	const refused = fixture.launch([...args, '.agents/skills/alpha']);
	expect(refused.status).not.toBe(0);
	expect(refused.stdout).toBe('');
});
