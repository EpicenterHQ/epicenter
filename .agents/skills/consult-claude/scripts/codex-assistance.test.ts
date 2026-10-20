/**
 * Verifies host-selected Codex tool capabilities, checkout and skill write
 * boundaries, connection-local sessions, and native execution results.
 * Fake CLI traces assert arguments and briefs without granting live access.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAssistance } from './codex-assistance.js';

const sessionId = '12345678-1234-1234-1234-123456789abc';

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-assistance-')));
	const source = join(root, 'source');
	const worker = join(root, 'worker');
	const bin = join(root, 'bin');
	const trace = join(root, 'trace.jsonl');
	for (const cwd of [source, worker]) {
		mkdirSync(cwd);
		expect(spawnSync('git', ['init', '-q', cwd]).status).toBe(0);
	}
	mkdirSync(bin);
	writeFileSync(trace, '');
	writeFileSync(
		join(bin, 'codex'),
		`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync('${trace}', JSON.stringify({args, cwd:process.cwd(), apiKey:process.env.OPENAI_API_KEY, endpoint:process.env.OPENAI_BASE_URL})+'\\n');
if (args[0] === 'login') { console.log(process.env.ASSIST_AUTH_API ? 'Logged in using an API key' : 'Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'mcp') { console.log(process.env.ASSIST_INVENTORY || JSON.stringify([{name:'local_probe',transport:{type:'stdio'}},{name:'remote_probe',transport:{type:'streamable_http'}}])); process.exit(0); }
const input = await Bun.stdin.text();
appendFileSync('${trace}', JSON.stringify({input})+'\\n');
console.log(JSON.stringify({type:'thread.started', thread_id:'${sessionId}'}));
if (input.includes('MALFORMED')) { console.log('not-json'); process.exit(0); }
if (input.includes('WAIT')) await new Promise(r=>setTimeout(r,10000));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message',text:'Source: source.ts:1. Coverage: all callers. Uncertainty: runtime check pending.'}}));
if (input.includes('LONG')) console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'x'.repeat(17000)}}));
if (input.includes('FAIL')) console.log(JSON.stringify({type:'turn.failed', error:{message:'Permission denied'}}));
else if (!input.includes('INCOMPLETE')) console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));
`,
		{ mode: 0o755 },
	);
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:${oldPath}`;
	return {
		source,
		worker,
		root,
		create(
			mode: 'consult' | 'delegate' = 'consult',
			limits = {},
			cwd = mode === 'delegate' ? worker : source,
		) {
			return createCodexAssistance({
				source,
				cwd,
				mode,
				model: 'test-model',
				...limits,
			});
		},
		trace() {
			return readFileSync(trace, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		[Symbol.dispose]() {
			process.env.PATH = oldPath;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test('consultation exposes evidence only and refuses access controls or foreign sessions before launch', async () => {
	using fixture = setup();
	const assistance = fixture.create();
	expect(assistance.tools.map((tool) => tool.name)).toEqual(['evidence']);
	for (const [tool, input] of [
		['implement', { prompt: 'change code' }],
		['evidence', { prompt: 'read code', cwd: fixture.worker }],
		['evidence', { prompt: 'read code', sandbox: 'danger-full-access' }],
		['evidence', { prompt: 'read code', session_id: sessionId }],
		['evidence', { prompt: ' ' }],
		['evidence', { prompt: 'x'.repeat(24001) }],
	] as const)
		expect((await assistance.callTool(tool, input)).isError).toBe(true);
	expect(fixture.trace()).toEqual([]);
});

test('native results retain session and usage, resume the same capability, and pin restrictions', async () => {
	using fixture = setup();
	const assistance = fixture.create();
	for (const input of [
		{ prompt: 'Map callers.' },
		{ prompt: 'Narrow that map.', session_id: sessionId },
	]) {
		const result = await assistance.callTool('evidence', input);
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({
			session_id: sessionId,
			completed: true,
			requested_model: 'test-model',
			cwd: fixture.source,
			usage: { input_tokens: 12 },
		});
	}
	const runs = fixture.trace().filter((entry) => entry.args?.[0] === 'exec');
	expect(runs).toHaveLength(2);
	expect(runs[1].args).toContain('resume');
	for (const { args, cwd } of runs) {
		expect(cwd).toBe(fixture.source);
		expect(args).toContain('sandbox_mode="read-only"');
		expect(args).toContain('approval_policy="never"');
		expect(args).toContain('model_reasoning_effort="medium"');
		expect(args).toContain('mcp_servers.local_probe.enabled=false');
		expect(args).toContain('mcp_servers.remote_probe.enabled=false');
		expect(args).toContain('mcp_servers.local_probe.command="false"');
		expect(args).toContain(
			'mcp_servers.remote_probe.url="https://disabled.invalid"',
		);
		expect(args).toContain('--ignore-user-config');
		expect(args).toContain('--ignore-rules');
		expect(args).toContain('multi_agent');
	}
});

test('implementation writes in the current checkout or a standalone clone, and evidence sessions cannot become workers', async () => {
	using fixture = setup();
	for (const target of [fixture.source, fixture.worker]) {
		const assistance = fixture.create('delegate', {}, target);
		expect(assistance.tools.map((tool) => tool.name)).toEqual([
			'evidence',
			'implement',
		]);
		expect(
			(await assistance.callTool('evidence', { prompt: 'Map callers.' }))
				.isError,
		).toBe(false);
		expect(
			(
				await assistance.callTool('implement', {
					prompt: 'Change code.',
					session_id: sessionId,
				})
			).isError,
		).toBe(true);
		expect(
			(await assistance.callTool('implement', { prompt: 'Change code.' }))
				.isError,
		).toBe(false);
		const trace = fixture.trace();
		const index = trace.findLastIndex((entry) => entry.args?.[0] === 'exec');
		const run = trace[index];
		expect(run.cwd).toBe(target);
		for (const arg of [
			'sandbox_mode="workspace-write"',
			'sandbox_workspace_write.network_access=false',
			'sandbox_workspace_write.writable_roots=[]',
		])
			expect(run.args).toContain(arg);
		expect(run.args).not.toContain('default_permissions="claude-skills"');
		expect(trace[index + 1].input).toContain('only in the assigned checkout');
		expect(trace[index + 1].input).toContain('paused edits');
	}
});

test('zero exit is insufficient when completion is missing or native turn reports failure', async () => {
	using fixture = setup();
	for (const prompt of ['INCOMPLETE', 'FAIL']) {
		const result = await fixture.create().callTool('evidence', { prompt });
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]!.text).exit_code).toBe(0);
	}
});

test('unknown server inventory refuses dispatch and oversized final reports mark truncation', async () => {
	using fixture = setup();
	try {
		process.env.ASSIST_INVENTORY = JSON.stringify([
			{ name: 'cannot.override', transport: { type: 'stdio' } },
		]);
		const denied = await fixture
			.create()
			.callTool('evidence', { prompt: 'never send' });
		expect(denied.isError).toBe(true);
		expect(fixture.trace().some((entry) => entry.args?.[0] === 'exec')).toBe(
			false,
		);
	} finally {
		delete process.env.ASSIST_INVENTORY;
	}
	const long = await fixture.create().callTool('evidence', { prompt: 'LONG' });
	const report = JSON.parse(long.content[0]!.text);
	expect(long.isError).toBe(false);
	expect(report.truncated).toBe(true);
	expect(report.result).toHaveLength(16000);
	expect(
		(await fixture.create().callTool('evidence', { prompt: 'MALFORMED' }))
			.isError,
	).toBe(true);
});

test('serial execution, cancellation and a call limit prevent additional worker launches', async () => {
	using fixture = setup();
	const assistance = fixture.create('delegate', { maxCalls: 1 });
	const controller = new AbortController();
	const running = assistance.callTool(
		'implement',
		{ prompt: 'WAIT' },
		controller.signal,
	);
	const overlap = await assistance.callTool('implement', { prompt: 'overlap' });
	expect(overlap.isError).toBe(true);
	expect(overlap.content[0]!.text).toContain('already running');
	controller.abort();
	const result = await running;
	expect(result.isError).toBe(true);
	expect(JSON.parse(result.content[0]!.text).cancelled).toBe(true);
	expect(
		(await assistance.callTool('implement', { prompt: 'next' })).content[0]!
			.text,
	).toContain('limit reached');
});

test('timeout ends the helper and reports incomplete work', async () => {
	using fixture = setup();
	const result = await fixture
		.create('consult', { timeoutMs: 100 })
		.callTool('evidence', { prompt: 'WAIT' });
	expect(result.isError).toBe(true);
	expect(JSON.parse(result.content[0]!.text)).toMatchObject({
		timed_out: true,
		completed: false,
	});
});

test('native ChatGPT login is required and inherited API overrides are removed', async () => {
	using fixture = setup();
	const previous = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
	};
	try {
		process.env.OPENAI_API_KEY = 'secret-key';
		process.env.OPENAI_BASE_URL = 'https://wrong-provider.invalid';
		expect(
			(await fixture.create().callTool('evidence', { prompt: 'map' })).isError,
		).toBe(false);
		expect(JSON.stringify(fixture.trace())).not.toContain('secret-key');
		expect(JSON.stringify(fixture.trace())).not.toContain('wrong-provider');
		process.env.ASSIST_AUTH_API = '1';
		const result = await fixture
			.create()
			.callTool('evidence', { prompt: 'never send' });
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain('native ChatGPT login');
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		delete process.env.ASSIST_AUTH_API;
	}
});

test('delegation refuses targets inside or containing the checkout, external linked worktrees and non-repositories; consultation stays in its source', () => {
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
	const nested = join(fixture.source, '..nested');
	expect(spawnSync('git', ['init', '-q', nested]).status).toBe(0);
	expect(spawnSync('git', ['init', '-q', fixture.root]).status).toBe(0);
	const linked = join(fixture.root, 'linked');
	expect(git(['worktree', 'add', '--detach', linked]).status).toBe(0);
	const plain = join(fixture.root, 'plain');
	mkdirSync(plain);
	for (const cwd of [nested, fixture.root, linked, plain])
		expect(() => fixture.create('delegate', {}, cwd)).toThrow();
	expect(() => fixture.create('consult', {}, fixture.worker)).toThrow(
		'assigned source checkout',
	);
	expect(() =>
		createCodexAssistance({
			source: linked,
			cwd: linked,
			mode: 'delegate',
			model: 'test',
		}),
	).not.toThrow();
});

test('implementation profile pins protected paths and host-selected skill roots while evidence stays read-only', async () => {
	using fixture = setup();
	for (const name of ['alpha', 'beta'])
		mkdirSync(join(fixture.source, '.agents/skills', name), {
			recursive: true,
		});
	const assistance = fixture.create(
		'delegate',
		{
			writeRoots: [
				'.agents/skills/alpha',
				join(fixture.source, '.agents/skills/alpha'),
				'.agents/skills/beta',
			],
		},
		fixture.source,
	);
	expect(
		(await assistance.callTool('evidence', { prompt: 'Map callers.' })).isError,
	).toBe(false);
	const evidenceArgs: string[] = fixture
		.trace()
		.findLast((entry) => entry.args?.[0] === 'exec').args;
	expect(evidenceArgs).toContain('sandbox_mode="read-only"');
	expect(evidenceArgs).not.toContain('default_permissions="claude-skills"');
	expect(evidenceArgs.some((arg) => arg.includes('skills/alpha'))).toBe(false);
	expect(
		(await assistance.callTool('implement', { prompt: 'Change code.' }))
			.isError,
	).toBe(false);
	const args: string[] = fixture
		.trace()
		.findLast((entry) => entry.args?.[0] === 'exec').args;
	expect(args).toContain('default_permissions="claude-skills"');
	expect(args.some((arg) => arg.startsWith('sandbox_mode='))).toBe(false);
	const profileArg = args.find((arg) =>
		arg.startsWith('permissions.claude-skills='),
	)!;
	expect(args[args.indexOf('default_permissions="claude-skills"') - 1]).toBe(
		'-c',
	);
	expect(args[args.indexOf(profileArg) - 1]).toBe('-c');
	const value = profileArg.slice('permissions.claude-skills='.length);
	// Fake codex does not parse -c, so this guards the TOML shape the native CLI requires.
	expect(
		(Bun.TOML.parse(`profile = ${value}`) as { profile: unknown }).profile,
	).toEqual({
		filesystem: {
			':root': 'read',
			':tmpdir': 'write',
			':slash_tmp': 'write',
			':workspace_roots': {
				'.': 'write',
				'.git': 'read',
				'.agents': 'read',
				'.codex': 'read',
				'.aws': 'read',
				'.agents/skills/alpha': 'write',
				'.agents/skills/beta': 'write',
			},
		},
		network: { enabled: false },
	});
});

test('neither tool arguments nor a later connection widen access', async () => {
	using fixture = setup();
	mkdirSync(join(fixture.source, '.agents/skills/alpha'), { recursive: true });
	const assistance = fixture.create(
		'delegate',
		{ writeRoots: ['.agents/skills/alpha'] },
		fixture.source,
	);
	for (const input of [
		{ prompt: 'p', write_root: '.agents' },
		{ prompt: 'p', writeRoots: ['.agents'] },
		{ prompt: 'p', permissions: 'danger-full-access' },
		{ prompt: 'p', cwd: fixture.worker },
	])
		expect((await assistance.callTool('implement', input)).isError).toBe(true);
	expect(
		fixture.trace().filter((entry) => entry.args?.[0] === 'exec'),
	).toHaveLength(0);
	const evidence = await assistance.callTool('evidence', { prompt: 'p' });
	expect(evidence.isError).toBe(false);
	expect(JSON.parse(evidence.content[0]!.text).session_id).toBe(sessionId);
	const count = fixture
		.trace()
		.filter((entry) => entry.args?.[0] === 'exec').length;
	const later = fixture.create('delegate', {}, fixture.source);
	expect(
		(await later.callTool('evidence', { prompt: 'p', session_id: sessionId }))
			.isError,
	).toBe(true);
	expect(
		fixture.trace().filter((entry) => entry.args?.[0] === 'exec'),
	).toHaveLength(count);
});

test('write roots are refused in consultation and outside the assigned skills directory', () => {
	using fixture = setup();
	mkdirSync(join(fixture.source, '.agents/skills/alpha'), { recursive: true });
	const outside = join(fixture.root, 'outside');
	mkdirSync(outside);
	symlinkSync(outside, join(fixture.source, '.agents/skills/escape'));
	writeFileSync(join(fixture.source, '.agents/skills/file.txt'), 'file');
	expect(() =>
		fixture.create('consult', { writeRoots: ['.agents/skills/alpha'] }),
	).toThrow('delegate mode');
	for (const root of [
		'.agents/skills',
		'.agents',
		'../outside',
		'.agents/skills/escape',
		'.agents/skills/file.txt',
		'.agents/skills/missing',
	])
		expect(() =>
			fixture.create('delegate', { writeRoots: [root] }, fixture.source),
		).toThrow();
});
