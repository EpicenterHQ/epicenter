import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { defineAction, type Update } from '../action.ts';
import { defineData } from '../data.ts';
import { defineEpicenter } from '../epicenter.ts';
import { field } from '../field.ts';
import type { Program } from './program.ts';
import { createHandler } from './serve.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

/** A home whose program is made here rather than imported, with its data in a temporary folder. */
async function setup() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-serve-'));
	homes.push(folder);
	const { notes } = defineData(folder, {
		notes: { description: 'note', fields: { kind: field.text() } },
	});
	const add = defineAction({
		description: 'Save a note',
		input: { id: field.text(), body: field.text() },
		async run({ id, body }, update: Update<string>) {
			update('writing');
			return notes.create(id, { kind: 'thought', body });
		},
	});
	const fail = defineAction({
		description: 'Always throws',
		input: {},
		run: () => {
			throw new Error('broke');
		},
	});
	const tag = defineAction({
		description: 'Takes words shaped by a pattern and nested raw TypeBox',
		input: {
			word: field.text({ pattern: '\\S', description: 'not blank' }),
			meta: Type.Optional(Type.Object({ n: Type.Number() })),
		},
		run: () => Ok(null),
	});
	const odd = defineAction({
		description: 'Has a raw pattern that is not a regular expression',
		input: { code: Type.String({ pattern: '[' }) },
		run: () => Ok(null),
	});
	const bare = defineAction({
		description: 'Forgets its Result',
		input: {},
		run: () => 'plain' as never,
	});
	const fake = defineAction({
		description: 'Returns a name only Epicenter answers',
		input: { name: field.select(['NotStarted', 'Threw', 'Unreachable']) },
		run: ({ name }) => Err({ name, message: 'not really' }),
	});
	const send = defineAction({
		description: 'Sends as the owner',
		input: {},
		mcp: false,
		run: () => Ok('sent'),
	});
	const program: Program = {
		apps: defineEpicenter({
			apps: {
				writing: {
					description: 'Notes for later',
					actions: { add, fail, fake, tag, odd, bare, send },
				},
			},
		}).apps,
	};
	const answer = createHandler({ folder, port: 4747 }, program);
	const request = (path: string, init: RequestInit = {}) =>
		answer(
			new Request(`http://127.0.0.1:4747${path}`, {
				...init,
				headers: { host: '127.0.0.1:4747', ...init.headers },
			}),
		);
	return { folder, request };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read JSON whose shape they assert.
type Json = any;

const post = (body: unknown) => ({
	method: 'POST',
	body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** The JSON lines of a response. */
async function lines(response: Response) {
	return (await response.text())
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test('a call streams its updates, then its answer, and writes the record', async () => {
	const { folder, request } = await setup();
	const response = await request(
		'/actions/writing/add',
		post({ id: 'a', body: 'Fares drop in March' }),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('application/x-ndjson');
	expect(await lines(response)).toEqual([
		{ update: 'writing' },
		{
			answer: Ok({
				path: 'data/notes/a.md',
				id: 'a',
				kind: 'thought',
				body: 'Fares drop in March',
			}),
		},
	]);
	expect(await readFile(join(folder, 'data/notes/a.md'), 'utf8')).toBe(
		'---\nkind: "thought"\n---\nFares drop in March',
	);
});

test('a call serve refuses is one NotStarted line, and nothing runs', async () => {
	const { folder, request } = await setup();
	for (const [path, body, message] of [
		['/actions/writing/add', '{"id":"a"}', 'body is needed'],
		['/actions/writing/add', 'not json', 'The input is not one JSON object'],
		['/actions/writing/add', '{"id":"a","body":"x","x":1}', '"x" is not a key'],
		['/actions/writing/nope', '{}', 'writing has no action "nope"'],
		['/actions/nope/add', '{}', 'There is no app "nope"'],
		['/actions/writing/add/more', '{}', "is not an action's address"],
		['/actions/writing/tag', '{"word":" "}', 'word must match pattern "\\S"'],
		[
			'/actions/writing/tag',
			'{"word":"a","meta":{"n":"x"}}',
			'meta.n must be number',
		],
	] as const) {
		const [line] = await lines(await request(path, post(body)));
		expect(line.answer.error.name).toBe('NotStarted');
		expect(line.answer.error.message).toContain(message);
	}
	expect(await readdir(folder)).toEqual([]);
	// A throw before the answer still ends the stream with one.
	const [odd] = await lines(
		await request('/actions/writing/odd', post('{"code":"x"}')),
	);
	expect(odd.answer.error.name).toBe('Threw');
	expect(odd.answer.error.message).toContain('Invalid regular expression');
});

test('a throw is Threw, and so is a value that is not a Result or a reserved name', async () => {
	const { request } = await setup();
	const [threw] = await lines(await request('/actions/writing/fail', post({})));
	expect(threw.answer.error).toEqual({ name: 'Threw', message: 'broke' });
	const [bare] = await lines(await request('/actions/writing/bare', post({})));
	expect(bare.answer.error).toEqual({
		name: 'Threw',
		message: 'The action "bare" must return Ok(data) or Err(error)',
	});
	for (const name of ['NotStarted', 'Threw', 'Unreachable']) {
		const [fake] = await lines(
			await request('/actions/writing/fake', post({ name })),
		);
		expect(fake.answer.error).toEqual({
			name: 'Threw',
			message:
				'The action "fake" returned ' +
				name +
				', a name only Epicenter answers',
		});
	}
});

test('the listing has every app, action, description and input schema', async () => {
	const { request } = await setup();
	const listing: Json = await (await request('/actions/')).json();
	expect(listing.apps[0].name).toBe('writing');
	expect(listing.apps[0].actions[0]).toEqual({
		name: 'add',
		description: 'Save a note',
		input: {
			type: 'object',
			properties: { id: { type: 'string' }, body: { type: 'string' } },
			required: ['id', 'body'],
			additionalProperties: false,
		},
	});
});

test('MCP offers one tool per action and runs it', async () => {
	const { request } = await setup();
	const rpc = async (method: string, params: object): Promise<Json> =>
		(
			await request('/', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			})
		).json();
	const initialized = await rpc('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'test', version: '1' },
	});
	expect(initialized.result.serverInfo.name).toBe('epicenter');
	expect(initialized.result.instructions).toBeUndefined();
	const listed = await rpc('tools/list', {});
	expect(
		listed.result.tools.map((tool: { name: string }) => tool.name),
	).toEqual([
		'writing_add',
		'writing_fail',
		'writing_fake',
		'writing_tag',
		'writing_odd',
		'writing_bare',
	]);
	const called = await rpc('tools/call', {
		name: 'writing_add',
		arguments: { id: 'b', body: 'From an agent' },
	});
	expect(called.result.structuredContent.data.id).toBe('b');
	const refused = await rpc('tools/call', {
		name: 'writing_add',
		arguments: { id: 'c' },
	});
	expect(refused.result.isError).toBe(true);
	expect(refused.result.content[0].text).toContain('body is needed');
	const hidden = await rpc('tools/call', {
		name: 'writing_send',
		arguments: {},
	});
	expect(hidden.error.message).toContain('There is no tool "writing_send"');
});

test('an action marked mcp: false is listed and called outside MCP', async () => {
	const { request } = await setup();
	const listing: Json = await (await request('/actions/')).json();
	expect(listing.apps[0].actions.at(-1)).toMatchObject({
		name: 'send',
		mcp: false,
	});
	const [answer] = await lines(
		await request('/actions/writing/send', post({})),
	);
	expect(answer).toEqual({ answer: { data: 'sent', error: null } });
});

test('the guards refuse tunnels, foreign hosts and origins, and another home', async () => {
	const { request } = await setup();
	const statuses = async (headers: Record<string, string>) =>
		(await request('/actions/', { headers })).status;
	expect(await statuses({})).toBe(200);
	expect(await statuses({ 'tailscale-funnel-request': '?1' })).toBe(403);
	expect(await statuses({ 'cf-connecting-ip': '1.2.3.4' })).toBe(403);
	expect(await statuses({ host: 'evil.example' })).toBe(403);
	expect(await statuses({ host: 'laptop.tail1234.ts.net' })).toBe(200);
	expect(await statuses({ origin: 'http://evil.example' })).toBe(403);
	expect(await statuses({ origin: 'http://127.0.0.1:4747' })).toBe(200);
	expect(await statuses({ 'sec-fetch-site': 'cross-site' })).toBe(403);
	expect(await statuses({ 'sec-fetch-site': 'same-site' })).toBe(403);
	expect(await statuses({ 'sec-fetch-site': 'same-origin' })).toBe(200);
	expect(await statuses({ 'x-epicenter-home': '%2Felsewhere' })).toBe(409);
});

test('a home whose program did not load answers that one problem', async () => {
	const answer = createHandler(
		{ folder: '/home', port: 4747 },
		{ apps: {}, problem: 'epicenter.ts did not load: boom' },
	);
	const request = (path: string, init?: RequestInit) =>
		answer(
			new Request(`http://127.0.0.1:4747${path}`, {
				...init,
				headers: { host: '127.0.0.1:4747', ...init?.headers },
			}),
		);
	expect(await (await request('/actions/')).json()).toEqual({
		version: expect.any(String),
		apps: [],
		problem: 'epicenter.ts did not load: boom',
	});
	const [line] = await lines(await request('/actions/a/b', post({})));
	expect(line.answer.error.message).toContain('boom');
	const listed = (await (
		await request('/', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		})
	).json()) as { error: { message: string } };
	expect(listed.error.message).toContain('boom');
});
