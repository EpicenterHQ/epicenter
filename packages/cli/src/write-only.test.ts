/**
 * A `writeOnly` input is a secret sent in and never given back (ADR-0870):
 * MCP neither lists nor runs its action, its value never names a commit or
 * appears in a refusal, and the command line asks for it without echo.
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Action, defineAction, field } from '@epicenter/app';
import { askSecret, checkInput, readInput, usageLine } from './input.ts';
import { actionHelp } from './listing.ts';
import { callName } from './run.ts';
import { connectMcp, fixture, gitIn } from './runner.test-support.ts';

// The MCP test runs the real `epicenter serve` as a separate process.
setDefaultTimeout(30_000);

const SECRET = 'sk-not-a-real-token-4242';

const connect = defineAction({
	description: 'Connect with a token',
	input: {
		account: field.text({ optional: true }),
		token: field.text({
			writeOnly: true,
			pattern: '^sk-',
			description: 'a token starting sk-',
		}),
	},
	run: ({ account }) => ({ account: account ?? 'default' }),
});

/** Every `ask` for this test: answers each key from `answers`, and records which were asked. */
function asker(answers: Record<string, string | undefined>) {
	const asked: string[] = [];
	return {
		asked,
		ask: async (key: string) => {
			asked.push(key);
			return answers[key];
		},
	};
}

test('a write-only field carries JSON Schema writeOnly, and only text takes it', () => {
	expect(field.text({ writeOnly: true })).toMatchObject({
		type: 'string',
		writeOnly: true,
	});
	expect(field.text()).not.toHaveProperty('writeOnly');
});

test('an action refuses a write-only positional, and a collection refuses a write-only field', async () => {
	expect(() =>
		defineAction({
			description: 'Connect',
			input: { token: field.text({ writeOnly: true }) },
			positional: ['token'],
			run: () => true,
		}),
	).toThrow('write-only "token" as a positional');
	const { defineCollection } = await import('@epicenter/app');
	expect(() =>
		defineCollection({
			path: 'data/keys/{name}.md',
			fields: { token: field.text({ writeOnly: true }) },
		}),
	).toThrow('write-only field "token"');
});

test("a write-only value never names the call's commit", () => {
	// defineAction refuses a write-only positional; an action built by hand can still list one.
	const handMade = Object.assign(() => undefined, {
		description: 'Connect',
		input: { token: field.text({ writeOnly: true }) },
		positional: ['token'],
	}) as unknown as Action;
	expect(callName('keys', 'connect', handMade, { token: SECRET })).toBe(
		'keys: connect',
	);
	const named = defineAction({
		description: 'Add',
		input: { title: field.text() },
		positional: ['title'],
		run: () => true,
	});
	expect(callName('tasks', 'add', named, { title: 'Water  the\nplants' })).toBe(
		'tasks: add Water the plants',
	);
});

test('a refusal of a write-only value names the field and never quotes it', () => {
	const flag = (key: string) => `--${key}`;
	const misfits = [{ token: 'not-sk' }, { token: 42 }, { token: `x${SECRET}` }];
	for (const input of misfits) {
		const checked = checkInput(connect, input, flag);
		expect(checked).toHaveProperty('error');
		expect(JSON.stringify(checked)).not.toContain(String(input.token));
		expect((checked as { error: string }).error).toStartWith('--token');
	}
	expect(checkInput(connect, { token: SECRET }, flag)).toEqual({
		ok: true,
		input: { token: SECRET },
	});
});

test('the command line asks for a write-only field and never reads it from its arguments', async () => {
	const answered = asker({ token: SECRET });
	expect(await readInput(connect, ['--account', 'work'], answered.ask)).toEqual(
		{ ok: true, input: { account: 'work', token: SECRET } },
	);
	expect(answered.asked).toEqual(['token']);

	const unasked = asker({});
	for (const rest of [
		['--token', SECRET],
		[`--token=${SECRET}`],
		[SECRET],
		['--input', JSON.stringify({ token: SECRET })],
	]) {
		const refused = await readInput(connect, rest, unasked.ask);
		expect(refused).toHaveProperty('error');
		expect(JSON.stringify(refused)).not.toContain(SECRET);
	}
	expect(unasked.asked).toEqual([]);

	// No terminal to ask in: the refusal says how else to give it.
	const noTerminal = await readInput(connect, [], asker({}).ask);
	expect(noTerminal).toEqual({
		error:
			'--token is needed, and it is a secret, so it is asked for only in a terminal. Or pipe the input to --input -',
	});
	// A mistyped answer is refused without being repeated.
	const mistyped = await readInput(
		connect,
		[],
		asker({ token: 'oops-typo' }).ask,
	);
	expect(mistyped).toEqual({ error: '--token must be a token starting sk-' });
});

test('help shows a write-only field as asked for, and usage leaves out its flag', () => {
	expect(usageLine('keys', 'connect', connect)).toBe(
		'epicenter keys connect [--account <text>]',
	);
	expect(actionHelp('keys', 'connect', connect)).toContain('token (asked for)');
});

/** A terminal for `askSecret`: what is written to it, and a way to type. */
function fakeTerminal() {
	const input = Object.assign(new EventEmitter(), {
		isTTY: true,
		raw: false,
		setRawMode(raw: boolean) {
			input.raw = raw;
			return input;
		},
		setEncoding: () => input,
		resume: () => input,
		pause: () => input,
	});
	let written = '';
	const output = { write: (text: string) => (written += text) };
	return {
		terminal: { input, output } as unknown as Parameters<typeof askSecret>[1],
		type: (text: string) => input.emit('data', text),
		written: () => written,
		raw: () => input.raw,
	};
}

test('askSecret reads a line in raw mode and writes back none of it', async () => {
	const t = fakeTerminal();
	const asked = askSecret('token', t.terminal);
	expect(t.raw()).toBe(true);
	t.type('sk-not-a-reax');
	t.type('\u007fl-token-4242\r');
	expect(await asked).toBe(SECRET);
	expect(t.raw()).toBe(false);
	expect(t.written()).toBe('token (typing is not shown): \n');

	const stopped = fakeTerminal();
	const interrupted = askSecret('token', stopped.terminal);
	stopped.type('sk-half\u0003');
	expect(await interrupted).toBeUndefined();
	expect(stopped.written()).not.toContain('sk-half');

	const piped = {
		input: { isTTY: false },
		output: { write: () => true },
	} as unknown as Parameters<typeof askSecret>[1];
	expect(await askSecret('token', piped)).toBeUndefined();
});

const keysApp = `export default defineApp({ description: 'Keys', collections: {}, actions: {
	connect: defineAction({ description: 'Connect with a token', input: { token: field.text({ writeOnly: true }) },
		run: async ({ token }) => { await folder.write('data/key.local.md', token); await folder.write('data/connected.md', 'yes'); return { connected: true }; } }),
	status: defineAction({ description: 'Whether a token is kept', annotations: { readOnlyHint: true }, input: {}, run: () => ({ connected: false }) }),
} });`;

test('MCP neither lists nor runs an action with a write-only input; HTTP runs it and its commit does not name the value', async () => {
	const f = await fixture();
	const folder = await f.app('keys', keysApp);
	const { client, served, close } = await connectMcp(f);
	try {
		const listed = await client.listTools();
		const names = listed.tools.map((tool) => tool.name);
		expect(names).toContain('keys_status');
		expect(names).not.toContain('keys_connect');

		const refused = await client.callTool({
			name: 'keys_connect',
			arguments: { token: SECRET },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused)).not.toContain(SECRET);
		expect(JSON.stringify(refused)).toContain('not offered over MCP');
		expect(await Bun.file(join(folder, 'data/key.local.md')).exists()).toBe(
			false,
		);

		const posted = await fetch(`${served.base}/keys/connect`, {
			method: 'POST',
			body: JSON.stringify({ token: SECRET }),
		});
		expect(await posted.text()).toBe(
			'{"answer":{"returned":{"connected":true}}}\n',
		);
		const data = join(folder, 'data');
		expect(await gitIn(data, 'log', '-1', '--format=%s')).toBe('keys: connect');
		expect(await gitIn(data, 'log', '-p', '--format=%B')).not.toContain(SECRET);
	} finally {
		await close();
		await rm(f.root, { recursive: true, force: true });
	}
});
