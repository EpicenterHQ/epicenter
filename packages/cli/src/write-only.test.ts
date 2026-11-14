/**
 * Confidentiality belongs to the whole action: no input reaches MCP, CLI
 * arguments, validation diagnostics, or commit subjects. HTTP and the real
 * CLI JSON-stdin path still run it, including nested secret schemas.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAction, field } from '@epicenter/app';
import { Type } from 'typebox';
import { checkInput, readInput, usageLine } from './input.js';
import { actionHelp } from './listing.js';
import { callName } from './run.js';
import { connectMcp, fixture, gitIn } from './runner.test-support.js';

setDefaultTimeout(30_000);
const SECRET = 'sk-not-a-real-token-4242';
const connect = defineAction({
	description: 'Connect with a token',
	input: {
		label: field.select(['work', 'personal']),
		credentials: Type.Object({
			token: field.text({ writeOnly: true, pattern: '^sk-' }),
		}),
	},
	positional: ['label', 'credentials'],
	run: () => ({ connected: true }),
});
const input = { label: 'work', credentials: { token: SECRET } };

test('a confidential call omits even an ordinary first positional from its commit name', () => {
	expect(callName('keys', 'connect', connect, input)).toBe('keys: connect');
	const ordinary = defineAction({
		description: 'Add',
		input: { title: field.text() },
		positional: ['title'],
		run: () => true,
	});
	expect(
		callName('tasks', 'add', ordinary, { title: 'Water  the\nplants' }),
	).toBe('tasks: add Water the plants');
});

test('validation keeps every supplied value and undeclared property name confidential', () => {
	for (const raw of [
		{ ...input, label: SECRET },
		{ ...input, credentials: { token: `wrong-${SECRET}` } },
		{ ...input, [SECRET]: true },
		{ credentials: input.credentials },
		null,
	])
		expect(checkInput(connect, raw, (key) => key)).toEqual({
			error: 'The input is not accepted',
		});
	expect(checkInput(connect, input, (key) => key)).toEqual({ ok: true, input });
});

test('the CLI refuses confidential arguments before parsing or quoting any of them', async () => {
	for (const rest of [
		[],
		[SECRET],
		['--label', SECRET],
		[`--${SECRET}=bad`],
		['--input', JSON.stringify(input)],
		['--input', '-', '--label', SECRET],
	]) {
		const refused = await readInput(connect, rest);
		expect(refused).toEqual({
			error:
				'This action takes a secret. Use the app page or pipe a JSON object to --input -',
		});
		expect(JSON.stringify(refused)).not.toContain(SECRET);
	}
});

test('help describes one JSON-stdin command and its JSON keys', () => {
	expect(usageLine('keys', 'connect', connect)).toBe(
		'epicenter keys connect --input -',
	);
	const help = actionHelp('keys', 'connect', connect);
	expect(help).toContain('credentials');
	expect(help).not.toContain('--label');
	expect(help).not.toContain('(asked for)');
});

const keysApp = `export default defineApp({ description: 'Keys', collections: {}, actions: {
	connect: defineAction({ description: 'Connect', input: { label: field.select(['work', 'personal']), credentials: { type: 'object', required: ['token'], properties: { token: field.text({ writeOnly: true, pattern: '^sk-' }) } } }, positional: ['label', 'credentials'],
		run: async ({ credentials }) => { await folder.write('data/key.local.md', credentials.token); await folder.write('data/connected.md', 'yes'); return { connected: true }; } }),
	check: defineAction({ description: 'Optional token', input: { token: field.text({ writeOnly: true, optional: true }) }, run: () => true }),
	literal: defineAction({ description: 'Reserved marker in examples', input: { value: { type: 'string', examples: [{ writeOnly: true }] } }, run: () => true }),
	status: defineAction({ description: 'Status', input: {}, run: () => true }),
} });`;

test('nested, optional, and literal markers hide and refuse entire MCP actions; HTTP and CLI stdin run them', async () => {
	const f = await fixture();
	const folder = await f.app('keys', keysApp);
	const { client, served, close } = await connectMcp(f);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain('keys_status');
		for (const name of ['keys_connect', 'keys_check', 'keys_literal']) {
			expect(names).not.toContain(name);
			const refused = await client.callTool({ name, arguments: {} });
			expect(refused.isError).toBe(true);
			expect(JSON.stringify(refused)).toContain('not offered over MCP');
		}
		const refused = await f.run('keys', 'connect', `--${SECRET}=bad`, '--json');
		expect(refused.code).toBe(2);
		expect(refused.stdout + refused.stderr).not.toContain(SECRET);
		expect(await Bun.file(join(folder, 'data/key.local.md')).exists()).toBe(
			false,
		);
		const bad = await fetch(`${served.base}/keys/connect`, {
			method: 'POST',
			body: JSON.stringify({ ...input, [SECRET]: true }),
		});
		expect(await bad.text()).not.toContain(SECRET);
		expect(await Bun.file(join(folder, 'data/key.local.md')).exists()).toBe(
			false,
		);
		const posted = await fetch(`${served.base}/keys/connect`, {
			method: 'POST',
			body: JSON.stringify(input),
		});
		expect(await posted.text()).toBe(
			'{"answer":{"returned":{"connected":true}}}\n',
		);
		const child = Bun.spawn(
			[process.execPath, f.bin, 'keys', 'connect', '--input', '-', '--json'],
			{
				cwd: f.root,
				env: f.env,
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(stdout)).toEqual({ returned: { connected: true } });
		expect(stderr).not.toContain(SECRET);
		const data = join(folder, 'data');
		expect(await gitIn(data, 'log', '-1', '--format=%s')).toBe('keys: connect');
		expect(await gitIn(data, 'log', '-p', '--format=%B')).not.toContain(SECRET);
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});
