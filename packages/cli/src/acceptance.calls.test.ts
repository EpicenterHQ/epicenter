/** Action calls preserve output, local-file permissions, concurrent writes, and lock release without Git bookkeeping. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
	connectMcp,
	fixture,
	gitignore,
	header,
	startServe,
} from './runner.test-support.js';

/** A port nothing listens on, for a home whose commands must find its serve. */
async function freePort() {
	const probe = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const { port } = probe;
	probe.stop(true);
	return port;
}

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const notesCode = `${header}
import { ActionError } from '@epicenter/app';
export default defineApp({
	description: 'The notes app',
	collections: {},
	actions: {
  declined: defineAction({description:'Decline',input:{},run:()=>ActionError.Refused({message:'Nothing to write',next:'epicenter notes write'})}),
  'no-route': defineAction({description:'No route',input:{},run:()=>Err({name:'NoRoute',message:'No route from LAX',airport:'LAX'})}),
  'thrown-refusal': defineAction({description:'Throw refusal',input:{},run:()=>{throw ActionError.Refused({message:'thrown refusal'}).error;}}),
  plain: defineAction({description:'Break contract',input:{},run:()=> 'not a result'}),
		write: defineAction({
			description: 'Write a page and a second data file',
			input: { page: field.text() },
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
				await folder.write('data/node_modules/seen.txt', page);
				return Ok(page);
			},
		}),
		same: defineAction({
			description: 'Write a page as it already is',
			input: {},
			run: async () => {
				await folder.write('data/a.md', 'base a\\n');
			 return Ok(undefined); },
		}),
		picture: defineAction({
			description: 'Write a binary',
			input: {},
			run: async () => {
				await folder.writeBytes('data/cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
			 return Ok(undefined); },
		}),
		half: defineAction({
			description: 'Write a page, then throw',
			input: { page: field.text() },
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
				throw new Error('stopped halfway');
			},
		}),
		peek: defineAction({
			description: 'Say it only reads, then write',
			input: {},
			annotations: { readOnlyHint: true },
			run: async () => {
				await folder.write('data/peek.md', 'peeked');
			 return Ok(undefined); },
		}),
		refresh: defineAction({
			description: 'Say it only reads, then keep a token on this computer',
			input: {},
			annotations: { readOnlyHint: true },
			run: async () => { await folder.write('data/token.local.md', 'kept'); return Ok(undefined); },
		}),
		tagged: defineAction({
			description: 'Throw a tagged error',
			input: {},
			run: () => {
				throw Object.freeze({ name: 'NotFound', message: 'no such page', page: 'x' });
			},
		}),
		exit: defineAction({
			description: 'End the process without an answer',
			input: {},
			run: () => process.exit(7),
		}),
		pair: defineAction({
			description: 'Write one page, wait until told to go on, then write another',
			input: { go: field.text() },
			run: async ({ go }) => {
				await folder.write('data/first.md', 'first');
				while (!(await Bun.file(go).exists())) await Bun.sleep(20);
				await folder.write('data/second.md', 'second');
			 return Ok(undefined); },
		}),
		chatty: defineAction({
			description: 'Log to the console every way and return',
			input: {},
			run: () => {
				console.log('hello from log');
				console.info('hello from info');
				console.debug('hello from debug');
				console.table([{ a: 1 }]);
				process.stdout.write('raw stdout\\n');
				return Ok('answer');
			},
		}),
	},
});
`;

const notesApp = {
	'code/.gitignore': gitignore,
	'data/a.md': 'base a\n',
	'code/epicenter.ts': notesCode,
};

async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.folder(join(f.apps, 'notes'), notesApp);
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, answer: JSON.parse(result.stdout) };
	};
	return { ...f, dir: folder, data: join(folder, 'data'), json };
}
test('C7 exit codes: 0 Ok, 1 Err or fault, 2 did not run; an action that exits the process ends the command', async () => {
	const f = await setup();
	const tagged = await f.json('notes', 'tagged');
	expect(tagged.code).toBe(1);
	expect(tagged.answer).toEqual({
		data: null,
		error: {
			kind: 'fault',
			message: 'no such page',
			thrown: { name: 'NotFound', message: 'no such page', page: 'x' },
		},
	});

	const noRoute = await f.json('notes', 'no-route');
	expect(noRoute.code).toBe(1);
	expect(noRoute.answer).toEqual({
		data: null,
		error: {
			kind: 'returned',
			reason: { name: 'NoRoute', message: 'No route from LAX', airport: 'LAX' },
		},
	});
	expect(await f.run('notes', 'no-route')).toEqual({
		code: 1,
		stdout: '',
		stderr: 'No route from LAX\n',
	});
	expect(await f.run('notes', 'declined')).toEqual({
		code: 1,
		stdout: '',
		stderr: 'Nothing to write\nRun: epicenter notes write\n',
	});
	const declined = await f.json('notes', 'declined');
	expect(declined.code).toBe(1);
	expect(declined.answer.error.reason).toMatchObject({
		name: 'Refused',
		namespace: 'epicenter/action-error',
	});
	const thrown = await f.json('notes', 'thrown-refusal');
	expect(thrown.code).toBe(1);
	expect(thrown.answer.error.thrown.name).toBe('Refused');
	expect(thrown.answer).not.toHaveProperty('result');
	const plain = await f.json('notes', 'plain');
	expect(plain.code).toBe(1);
	expect(plain.answer).toEqual({
		data: null,
		error: { kind: 'fault', message: expect.any(String) },
	});
	const exited = await f.run('notes', 'exit', '--json');
	expect(exited).toMatchObject({ code: 7, stdout: '' });
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.answer).toMatchObject({
		data: null,
		error: { kind: 'refused', reason: { name: 'Usage' } },
	});
	const human = await f.run('notes', 'write', '{"page":"monday"}');
	expect(human).toEqual({ code: 0, stdout: 'monday\n', stderr: '' });
});

test('C10 a read-only hint refuses nothing, and a .local file is readable by its owner alone', async () => {
	const f = await setup();
	const peek = await f.json('notes', 'peek');
	expect(peek).toMatchObject({ code: 0, answer: { data: null, error: null } });
	expect(await readFile(join(f.dir, 'data/peek.md'), 'utf8')).toBe('peeked');
	const refresh = await f.json('notes', 'refresh');
	expect(refresh).toMatchObject({
		code: 0,
		answer: { data: null, error: null },
	});
	expect(await readFile(join(f.dir, 'data/token.local.md'), 'utf8')).toBe(
		'kept',
	);
	expect((await stat(join(f.dir, 'data/token.local.md'))).mode & 0o777).toBe(
		0o600,
	);
});

test('C11 concurrent sets of different fields on one file all land while serve is running', async () => {
	const f = await setup();
	const fields = Array.from({ length: 10 }, (_, i) => `f${i}`);
	await f.folder(join(f.apps, 'many'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `${header}
const items = defineCollection({ path: 'data/items/{id}.md', fields: { ${fields.map((key) => `${key}: field.number({ optional: true })`).join(', ')} } });
export default defineApp({ description: 'Many fields', collections: { items }, actions: { items: items.actions() } });
`,
		'data/items/one.md': '---\n---\n',
	});
	// While serve is running it runs every action, so ten commands at once are
	// ten calls in one process, and no write is lost between them (ADR-0936).
	const port = await freePort();
	await writeFile(join(f.home, 'EPICENTER.md'), `---\nport: ${port}\n---\n`);
	const served = await startServe(f);
	let runs: Awaited<ReturnType<typeof f.run>>[];
	try {
		runs = await Promise.all(
			fields.map((key, i) =>
				f.run('many', 'items', 'set', JSON.stringify({ id: 'one', [key]: i })),
			),
		);
	} finally {
		await served.stop();
	}
	expect(runs.filter((run) => run.code !== 0 || run.stderr !== '')).toEqual([]);
	const text = await readFile(
		join(f.apps, 'many', 'data/items/one.md'),
		'utf8',
	);
	for (const [i, key] of fields.entries())
		expect(text).toContain(`${key}: ${i}\n`);
});

test('a command sends its action to serve while serve runs, and runs it itself when serve is stopped', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'where'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `${header}
export default defineApp({ description: 'Where', collections: {}, actions: {
	am: defineAction({ description: 'Say which process ran this', input: {}, run: async (_input, update) => { update('here'); return Ok(process.pid); } }),
} });
`,
	});
	const pidOf = async () => {
		const run = await f.run('where', 'am', '--json');
		expect(run.stderr).toBe('"here"\n');
		return (JSON.parse(run.stdout) as { data: number }).data;
	};
	const port = await freePort();
	await writeFile(join(f.home, 'EPICENTER.md'), `---\nport: ${port}\n---\n`);
	const served = await startServe(f);
	let inServe: number;
	try {
		inServe = await pidOf();
		expect(await pidOf()).toBe(inServe);
		// A call that names another home is refused before the action runs.
		const other = await fetch(`${served.base}/where/am`, {
			method: 'POST',
			headers: { 'x-epicenter-home': 'elsewhere' },
			body: '{}',
		});
		expect(other.status).toBe(409);
	} finally {
		await served.stop();
	}
	const alone = await pidOf();
	expect(alone).not.toBe(inServe);
	expect(await pidOf()).not.toBe(alone);
});

test('C12 runs leave no temporary file and no lock file', async () => {
	const f = await setup();
	const temp = join(f.root, 'tmp');
	await mkdir(temp);
	const env = { ...f.env, TMPDIR: temp };
	const run = (...args: string[]) =>
		Bun.spawn([process.execPath, f.bin, ...args], {
			cwd: f.root,
			env,
			stdout: 'ignore',
			stderr: 'ignore',
		}).exited;
	const exits = await Promise.all([
		run('notes', 'write', '{"page":"monday"}'),
		run('notes', 'write', '{"page":"tuesday"}'),
		run('notes', 'half', '{"page":"wednesday"}'),
	]);
	expect(exits).toEqual([0, 0, 1]);
	// macOS Git's launcher keeps its own cache in TMPDIR.
	expect((await readdir(temp)).filter((name) => name !== 'xcrun_db')).toEqual(
		[],
	);
	expect(
		(await readdir(f.dir, { recursive: true })).filter((name) =>
			name.endsWith('.tmp.local'),
		),
	).toEqual([]);
});

test('C8 stdout belongs to epicenter: an action that logs does not corrupt --json or an MCP answer', async () => {
	const f = await setup();
	const json = await f.json('notes', 'chatty');
	expect(json.code).toBe(0);
	expect(json.answer).toEqual({ data: 'answer', error: null });
	for (const line of ['hello from log', 'hello from info', 'raw stdout'])
		expect(json.stderr).toContain(line);
	const { client, close } = await connectMcp(f);
	try {
		const called = await client.callTool({
			name: 'notes_chatty',
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toEqual({ data: 'answer', error: null });
	} finally {
		await close();
	}
});
