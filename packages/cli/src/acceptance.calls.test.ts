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
import { hold } from './lock.js';
import {
	connectMcp,
	fixture,
	gitignore,
	header,
} from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const notesCode = `${header}
export default defineApp({
	description: 'The notes app',
	collections: {},
	actions: {
		write: defineAction({
			description: 'Write a page and a second data file',
			input: { page: field.text() },
			run: async ({ page }) => {
				await folder.write('data/' + page + '.md', page);
				await folder.write('data/node_modules/seen.txt', page);
				return page;
			},
		}),
		same: defineAction({
			description: 'Write a page as it already is',
			input: {},
			run: async () => {
				await folder.write('data/a.md', 'base a\\n');
			},
		}),
		picture: defineAction({
			description: 'Write a binary',
			input: {},
			run: async () => {
				await folder.writeBytes('data/cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
			},
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
			},
		}),
		refresh: defineAction({
			description: 'Say it only reads, then keep a token on this computer',
			input: {},
			annotations: { readOnlyHint: true },
			run: () => folder.write('data/token.local.md', 'kept'),
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
			},
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
				return 'answer';
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
test('C7 exit codes: 0 returned, 1 threw, 2 did not run; an action that exits the process ends the command', async () => {
	const f = await setup();
	const tagged = await f.json('notes', 'tagged');
	expect(tagged.code).toBe(1);
	expect(tagged.answer).toEqual({
		threw: {
			message: 'no such page',
			thrown: { name: 'NotFound', message: 'no such page', page: 'x' },
		},
	});
	const exited = await f.run('notes', 'exit', '--json');
	expect(exited).toMatchObject({ code: 7, stdout: '' });
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.answer.error).toMatchObject({ name: 'Usage' });
	const human = await f.run('notes', 'write', '{"page":"monday"}');
	expect(human).toEqual({ code: 0, stdout: 'monday\n', stderr: '' });
});

test('C10 a read-only action cannot write through folder, except a .local file, and can update a local file', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/b.md'), 'by hand\n');
	// A refused write is refused at once, not after waiting on another call's lock.
	const held = await hold(f.dir, 0);
	const peek = await f.json('notes', 'peek');
	held?.release();
	expect(peek.code).toBe(1);
	expect(peek.answer).toEqual({
		threw: {
			message:
				'The action "peek" is read-only, so it cannot write data/peek.md',
		},
	});
	expect(await Bun.file(join(f.dir, 'data/peek.md')).exists()).toBe(false);
	const refresh = await f.json('notes', 'refresh');
	expect(refresh).toMatchObject({ code: 0, answer: { returned: null } });
	expect(await readFile(join(f.dir, 'data/token.local.md'), 'utf8')).toBe(
		'kept',
	);
	expect((await stat(join(f.dir, 'data/token.local.md'))).mode & 0o777).toBe(
		0o600,
	);
});

test('C11 concurrent sets of different fields on one file all land', async () => {
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
	const runs = await Promise.all(
		fields.map((key, i) =>
			f.run('many', 'items', 'set', JSON.stringify({ id: 'one', [key]: i })),
		),
	);
	// Calls serialize read-modify-write operations across processes.
	expect(runs.filter((run) => run.code !== 0 || run.stderr !== '')).toEqual([]);
	const text = await readFile(
		join(f.apps, 'many', 'data/items/one.md'),
		'utf8',
	);
	for (const [i, key] of fields.entries())
		expect(text).toContain(`${key}: ${i}\n`);
});

test('C12 runs leave no temporary file and no lock file, and hold no lock once they answer', async () => {
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
	// The app's lock is the folder's own, and no one holds it.
	const held = await hold(f.dir, 0);
	expect(held).toBeDefined();
	held?.release();
});

test('C8 stdout belongs to epicenter: an action that logs does not corrupt --json or an MCP answer', async () => {
	const f = await setup();
	const json = await f.json('notes', 'chatty');
	expect(json.code).toBe(0);
	expect(json.answer).toEqual({ returned: 'answer' });
	for (const line of ['hello from log', 'hello from info', 'raw stdout'])
		expect(json.stderr).toContain(line);
	const { client, close } = await connectMcp(f);
	try {
		const called = await client.callTool({
			name: 'notes_chatty',
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(called.structuredContent).toEqual({ returned: 'answer' });
	} finally {
		await close();
	}
});
