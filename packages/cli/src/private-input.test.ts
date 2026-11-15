/**
 * Private input handling belongs to the whole call: no input reaches MCP, CLI
 * arguments, validation diagnostics, or commit subjects. HTTP and the real
 * CLI JSON-stdin path still run it. Raw schema annotations do not imply policy.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineAction, field } from '@epicenter/app';
import { Type } from 'typebox';
import { checkInput, readInput, usageLine } from './input.js';
import { actionHelp } from './listing.js';
import { connectMcp, fixture } from './runner.test-support.js';

setDefaultTimeout(30_000);
const SECRET = 'sk-not-a-real-token-4242';
const connect = defineAction({
	description: 'Connect with a token',
	privateInput: true,
	input: {
		label: field.select(['work', 'personal']),
		credentials: Type.Object({
			token: field.text({ pattern: '^sk-' }),
		}),
	},
	positional: ['label', 'credentials'],
	run: () => ({ connected: true }),
});
const input = { label: 'work', credentials: { token: SECRET } };

test('validation keeps every supplied value and undeclared property name private', () => {
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

test('the CLI refuses private arguments before parsing or quoting any of them', async () => {
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
				'This action takes private input. Use the app page or pipe a JSON object to --input -',
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
	connect: defineAction({ description: 'Connect', privateInput: true, input: { label: field.select(['work', 'personal']), credentials: { type: 'object', required: ['token'], properties: { token: field.text({ pattern: '^sk-' }) } } }, positional: ['label', 'credentials'],
		run: async ({ credentials }) => { await folder.write('data/key.local.md', credentials.token); await folder.write('data/connected.md', 'yes'); return { connected: true }; } }),
	check: defineAction({ description: 'Optional token', privateInput: true, input: { token: field.text({ optional: true }) }, run: () => true }),
	annotated: defineAction({ description: 'Ordinary raw annotation', input: { value: { type: 'string', writeOnly: true } }, run: ({ value }) => value }),
	status: defineAction({ description: 'Status', privateInput: false, input: {}, run: () => true }),
} });`;

test('only privateInput hides and refuses MCP actions; HTTP and CLI stdin still run them', async () => {
	const f = await fixture();
	const folder = await f.app('keys', keysApp);
	const { client, served, close } = await connectMcp(f);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain('keys_status');
		expect(names).toContain('keys_annotated');
		for (const name of ['keys_connect', 'keys_check']) {
			expect(names).not.toContain(name);
			const refused = await client.callTool({ name, arguments: {} });
			expect(refused.isError).toBe(true);
			expect(JSON.stringify(refused)).toContain('not offered over MCP');
		}
		const annotated = await client.callTool({
			name: 'keys_annotated',
			arguments: { value: 'ordinary' },
		});
		expect(annotated.structuredContent).toEqual({ returned: 'ordinary' });
		const listing = await f.run('keys', '--json');
		const listed = JSON.parse(listing.stdout).actions.find(
			(action: { name: string }) => action.name === 'keys_connect',
		);
		expect(listed.privateInput).toBe(true);
		expect(listed).not.toHaveProperty('confidential');
		expect(listed.annotations).not.toHaveProperty('privateInput');
		const help = await f.run('keys', 'connect', '--help', '--json');
		expect(JSON.parse(help.stdout).privateInput).toBe(true);
		const refused = await f.run('keys', 'connect', `--${SECRET}=bad`, '--json');
		expect(refused.code).toBe(2);
		expect(refused.stdout + refused.stderr).not.toContain(SECRET);
		expect(await Bun.file(join(folder, 'data/key.local.md')).exists()).toBe(
			false,
		);
		const bad = await fetch(
			`${served.base}/.runs/keys/connect/${crypto.randomUUID()}`,
			{
				method: 'POST',
				body: JSON.stringify({ ...input, [SECRET]: true }),
			},
		);
		expect(await bad.text()).not.toContain(SECRET);
		expect(await Bun.file(join(folder, 'data/key.local.md')).exists()).toBe(
			false,
		);
		const posted = await fetch(
			`${served.base}/.runs/keys/connect/${crypto.randomUUID()}`,
			{
				method: 'POST',
				body: JSON.stringify(input),
			},
		);
		const frames = (await posted.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(frames.at(-1)).toMatchObject({
			type: 'finished',
			answer: { returned: { connected: true } },
		});
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
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});
