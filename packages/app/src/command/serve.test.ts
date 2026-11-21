import { afterEach, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { defineAction, type Update } from '../action.ts';
import { defineData } from '../data.ts';
import { defineEpicenter } from '../epicenter.ts';
import { field } from '../field.ts';
import { programOf } from './program.ts';
import { createHandler, serveHome } from './serve.ts';

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
	const sly = defineAction({
		description: 'Returns an error whose name throws when read',
		input: {},
		run: () =>
			Err({
				get name(): string {
					throw new Error('no name');
				},
				message: 'sly',
			}) as never,
	});
	const hostile = defineAction({
		description: 'Throws a value nothing can describe',
		input: {},
		run: () => {
			throw Object.assign(Object.create(null), { n: 1n });
		},
	});
	const big = defineAction({
		description: 'Returns what JSON cannot carry',
		input: {},
		// The type refuses a BigInt; plain JavaScript can still return one.
		run: () => Ok(1n) as never,
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
	const program = programOf(
		defineEpicenter({
			apps: {
				writing: {
					description: 'Notes for later',
					actions: { add, fail, fake, tag, big, sly, hostile, bare, send },
				},
			},
		}),
	);
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
});

test('a throw is Threw, and so is a value that is not a Result or a reserved name', async () => {
	const { request } = await setup();
	const [threw] = await lines(await request('/actions/writing/fail', post({})));
	expect(threw.answer.error).toEqual({ name: 'Threw', message: 'broke' });
	const [sly] = await lines(await request('/actions/writing/sly', post({})));
	expect(sly.answer.error).toEqual({ name: 'Threw', message: 'no name' });
	const [big] = await lines(await request('/actions/writing/big', post({})));
	expect(big.answer.error.name).toBe('Threw');
	expect(big.answer.error.message).toContain(
		'The action "big" returned what JSON cannot carry',
	);
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
		'writing_big',
		'writing_sly',
		'writing_hostile',
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
	expect(hidden.result.isError).toBe(true);
	expect(hidden.result.content[0].text).toContain('has no action "send"');
	// A throw nothing can describe is Threw on both, never a protocol error.
	const hostile = await rpc('tools/call', {
		name: 'writing_hostile',
		arguments: {},
	});
	expect(hostile.result.structuredContent.error.name).toBe('Threw');
	const [routed] = await lines(
		await request('/actions/writing/hostile', post({})),
	);
	expect(routed.answer.error.name).toBe('Threw');
});

test('an action marked mcp: false is still called outside MCP', async () => {
	const { request } = await setup();
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
		{
			apps: {},
			inputChecks: new Map(),
			problem: 'epicenter.ts did not load: boom',
		},
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

test('serve that cannot listen answers NotStarted, never a throw', async () => {
	const folder = realpathSync(process.cwd());
	// A port this test holds, so serve finds it taken.
	const holder = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = holder.port as number;
	try {
		const taken = await serveHome({ folder, port });
		expect(taken.error?.name).toBe('NotStarted');
		expect(taken.error?.message).toContain(`Port ${port} is in use`);
	} finally {
		await holder.stop(true);
	}
	// A port no socket can have fails another way, and is NotStarted too.
	const refused = await serveHome({ folder, port: 70000 });
	expect(refused.error?.name).toBe('NotStarted');
	expect(refused.error?.message).toContain('serve could not listen');
});

test("an app's page is its built files, and nothing outside them", async () => {
	const { folder, request } = await setup();
	const dist = join(folder, 'apps', 'writing', 'ui', 'dist');
	await mkdir(join(dist, 'fonts'), { recursive: true });
	await writeFile(join(dist, 'index.html'), '<h1>Writing</h1>');
	await writeFile(join(dist, 'fonts', 'geist.woff2'), 'font');
	await writeFile(join(dist, '.env'), 'SECRET=1');
	await writeFile(join(folder, 'apps', 'writing', 'secret.txt'), 'outside');
	await symlink(
		join(folder, 'apps', 'writing', 'secret.txt'),
		join(dist, 'link.txt'),
	);

	const page = await request('/apps/writing/');
	expect(page.status).toBe(200);
	expect(page.headers.get('content-type')).toContain('text/html');
	expect(page.headers.get('cache-control')).toBe('no-cache');
	expect(await page.text()).toBe('<h1>Writing</h1>');
	expect(await (await request('/apps/writing/fonts/geist.woff2')).text()).toBe(
		'font',
	);

	const bare = await request('/apps/writing');
	expect(bare.status).toBe(308);
	expect(bare.headers.get('location')).toBe('/apps/writing/');

	const status = async (path: string) => (await request(path)).status;
	expect(await status('/apps/writing/.env')).toBe(404);
	expect(await status('/apps/writing/..%2Fsecret.txt')).toBe(404);
	expect(await status('/apps/writing/fonts/..%2F..%2F..%2Fsecret.txt')).toBe(
		404,
	);
	expect(await status('/apps/writing/link.txt')).toBe(404);
	expect(await status('/apps/writing/fonts')).toBe(404);
	expect(await status('/apps/writing/missing.js')).toBe(404);
	expect(await status('/apps/nobody/')).toBe(404);
	expect((await request('/apps/writing/', { method: 'POST' })).status).toBe(
		405,
	);
	expect(
		(
			await request('/apps/writing/', {
				headers: { 'sec-fetch-site': 'cross-site' },
			})
		).status,
	).toBe(403);
});

test('a file comes in by PUT once, whatever layout the app chose', async () => {
	const { folder, request } = await setup();
	const put = (path: string, body: string) =>
		request(path, { method: 'PUT', body });

	// A folder of videos beside a page, and one video named like a page.
	expect((await put('/data/pages-1/intro/take-1.mp4', 'one')).status).toBe(201);
	expect((await put('/data/pages-1/intro/take-2.mp4', 'two')).status).toBe(201);
	expect((await put('/data/pages-2/intro.mp4', 'solo')).status).toBe(201);
	expect(await readdir(join(folder, 'data/pages-1/intro'))).toEqual([
		'take-1.mp4',
		'take-2.mp4',
	]);

	const read = await request('/data/pages-2/intro.mp4');
	expect(await read.text()).toBe('solo');
	expect(read.headers.get('content-security-policy')).toContain('sandbox');
	expect(read.headers.get('x-content-type-options')).toBe('nosniff');

	const again = await put('/data/pages-2/intro.mp4', 'other');
	expect(again.status).toBe(409);
	expect(await readFile(join(folder, 'data/pages-2/intro.mp4'), 'utf8')).toBe(
		'solo',
	);
	expect((await put('/data/pages-2/intro.mp4/x', 'no')).status).toBe(409);
	expect((await put('/data/notes/a.md', 'no')).status).toBe(403);
	expect((await put('/data/notes/a.MD', 'no')).status).toBe(403);
	expect((await put('/data/notes/.hidden', 'no')).status).toBe(400);
	expect((await put('/data/notes/..%2Fx', 'no')).status).toBe(400);
	expect((await request('/data/x.mp4', { method: 'DELETE' })).status).toBe(405);
	expect(
		(
			await request('/data/evil.mp4', {
				method: 'PUT',
				body: 'no',
				headers: { origin: 'https://evil.example' },
			})
		).status,
	).toBe(403);
});

test('a PUT cannot leave data/ through a link, and leaves no temp file', async () => {
	const { folder, request } = await setup();
	const outside = join(folder, 'outside');
	await mkdir(outside);
	await mkdir(join(folder, 'data'));
	await symlink(outside, join(folder, 'data', 'out'));
	const put = await request('/data/out/x.mp4', { method: 'PUT', body: 'no' });
	expect(put.status).toBe(403);
	expect(await readdir(outside)).toEqual([]);

	await request('/data/a/x.mp4', { method: 'PUT', body: 'yes' });
	expect(await readdir(join(folder, 'data/a'))).toEqual(['x.mp4']);
});

test('an action or MCP body past the JSON limit is 413, though a file may be larger', async () => {
	const { request } = await setup();
	const big = 'x'.repeat(25 * 1024 * 1024 + 1);
	const action = await request('/actions/writing/add', {
		method: 'POST',
		body: big,
	});
	expect(action.status).toBe(413);
	expect((await request('/', { method: 'POST', body: big })).status).toBe(413);
	expect(
		(await request('/data/big.bin', { method: 'PUT', body: big })).status,
	).toBe(201);
});
