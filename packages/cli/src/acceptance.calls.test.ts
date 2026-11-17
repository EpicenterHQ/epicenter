/**
 * Action call tests.
 * A command sends its action to the home's serve, the one process that runs
 * actions, and never runs it itself.
 *
 * Key behaviors:
 * - Exit codes and answers are the same through the command and MCP.
 * - Concurrent calls in one serve lose no write and leave no temporary file.
 * - With serve stopped, or another holder on the port, a command is refused and nothing runs.
 * - A second serve says whether this home or something else has the port.
 * - A command says when serve is another version.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from './engines.ts';
import {
	connectMcp,
	fixture,
	gitignore,
	header,
	startServe,
} from './runner.test-support.js';

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
			run: async () => { await folder.write('local/token.md', 'kept'); return Ok(undefined); },
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
test('C7 exit codes: 0 Ok, 1 Err or fault, 2 did not run; an action that exits the process ends serve, and the command answers a fault', async () => {
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
	// Serve runs the action, so an action that exits ends serve, and the
	// command is told the answer never came.
	const exited = await f.json('notes', 'exit');
	expect(exited).toMatchObject({ code: 1, stderr: '' });
	expect(exited.answer).toEqual({
		data: null,
		error: {
			kind: 'fault',
			message:
				'The connection to Epicenter ended before the answer; the action may still be running, or may have finished',
		},
	});
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.answer).toMatchObject({
		data: null,
		error: { kind: 'refused', reason: { name: 'Usage' } },
	});
	const human = await f.run('notes', 'write', '{"page":"monday"}');
	expect(human).toEqual({ code: 0, stdout: 'monday\n', stderr: '' });
});

test('C10 a read-only hint refuses nothing, and a file under local/ is readable by its owner alone', async () => {
	const f = await setup();
	const peek = await f.json('notes', 'peek');
	expect(peek).toMatchObject({ code: 0, answer: { data: null, error: null } });
	expect(await readFile(join(f.dir, 'data/peek.md'), 'utf8')).toBe('peeked');
	const refresh = await f.json('notes', 'refresh');
	expect(refresh).toMatchObject({
		code: 0,
		answer: { data: null, error: null },
	});
	expect(await readFile(join(f.dir, 'local/token.md'), 'utf8')).toBe('kept');
	expect((await stat(join(f.dir, 'local/token.md'))).mode & 0o777).toBe(0o600);
});

test('C11 concurrent sets of different fields on one file all land', async () => {
	const f = await setup();
	const fields = Array.from({ length: 10 }, (_, i) => `f${i}`);
	await f.folder(join(f.apps, 'many'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `${header}
const data = defineData({ items: { fields: { ${fields.map((key) => `${key}: field.number({ optional: true })`).join(', ')} } } });
export default defineApp({ description: 'Many fields', data, actions: { items: data.items.actions('set') } });
`,
		'data/items/one.md': '---\n---\n',
	});
	// Serve runs every action, so ten commands at once are ten calls in one
	// process, and no write is lost between them (ADR-0936).
	const runs = await Promise.all(
		fields.map((key, i) =>
			f.run('many', 'items', 'set', JSON.stringify({ id: 'one', [key]: i })),
		),
	);
	expect(runs.filter((run) => run.code !== 0 || run.stderr !== '')).toEqual([]);
	const text = await readFile(
		join(f.apps, 'many', 'data/items/one.md'),
		'utf8',
	);
	for (const [i, key] of fields.entries())
		expect(text).toContain(`${key}: ${i}\n`);
});

test('a command sends its action to serve, and is refused and runs nothing while serve is stopped', async () => {
	const f = await setup();
	const where = await f.folder(join(f.apps, 'where'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `${header}
export default defineApp({ description: 'Where', actions: {
	am: defineAction({ description: 'Say which process ran this', input: {}, run: async (_input, update) => {
		await folder.update('data/ran.txt', (before = '') => before + 'x');
		update('here');
		return Ok(process.pid);
	} }),
} });
`,
	});
	const ran = () => readFile(join(where, 'data/ran.txt'), 'utf8');
	const pidOf = async () => {
		const run = await f.run('where', 'am', '--json');
		expect(run.stderr).toBe('"here"\n');
		return (JSON.parse(run.stdout) as { data: number }).data;
	};
	const served = await startServe(f);
	try {
		const inServe = await pidOf();
		expect(inServe).not.toBe(process.pid);
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
	await f.stopServe();
	expect(await ran()).toBe('xx');
	const message =
		'Epicenter is not running for this home. Start it with `epicenter serve`, or keep it running with `epicenter service install`.';
	expect(await f.run('where', 'am')).toEqual({
		code: 2,
		stdout: '',
		stderr: `${message}\n`,
	});
	const refused = await f.json('where', 'am');
	expect(refused).toMatchObject({ code: 2, stderr: '' });
	expect(refused.answer).toEqual({
		data: null,
		error: { kind: 'refused', reason: { name: 'Refused', message } },
	});
	expect(await ran()).toBe('xx');
});

/** Hold the fixture's port as `answer` does, in place of its serve. */
async function holdPort(
	f: Awaited<ReturnType<typeof setup>>,
	answer: () => Response,
) {
	await f.stopServe();
	return Bun.serve({ hostname: '127.0.0.1', port: f.port, fetch: answer });
}

test('a command is refused, and runs nothing, when its port answers for another Epicenter or another program', async () => {
	const f = await setup();
	for (const [headers, holder] of [
		[{ 'x-epicenter-home': 'elsewhere' }, 'Epicenter'],
		[{}, 'program'],
	] as const) {
		let asked = 0;
		const other = await holdPort(f, () => {
			asked++;
			return new Response('{"answer":{"data":"theirs","error":null}}\n', {
				headers,
			});
		});
		try {
			expect(await f.run('notes', 'write', '{"page":"monday"}')).toEqual({
				code: 2,
				stdout: '',
				stderr: `Port ${f.port} answers for another ${holder}. Set a different \`port\` in EPICENTER.md.\n`,
			});
			expect(asked).toBe(1);
		} finally {
			await other.stop(true);
		}
	}
	expect(await Bun.file(join(f.data, 'monday.md')).exists()).toBe(false);
});

test('a command uses the answer of a serve of another version, and says to restart it', async () => {
	const f = await setup();
	for (const [version, running] of [
		['0.0.1', 'version 0.0.1'],
		[undefined, 'an older version'],
	] as const) {
		const old = await holdPort(
			f,
			() =>
				new Response(
					'{"update":"halfway"}\n{"answer":{"data":"ran","error":null}}\n',
					{
						headers: {
							'x-epicenter-home': encodeURIComponent(f.home),
							...(version ? { 'x-epicenter-version': version } : {}),
						},
					},
				),
		);
		try {
			expect(await f.run('notes', 'same', '--json')).toEqual({
				code: 0,
				stdout: '{"data":"ran","error":null}\n',
				stderr: `"halfway"\nEpicenter is running ${running} and this command is version ${VERSION}. Restart it with \`epicenter service restart\`, or stop \`epicenter serve\` and start it again.\n`,
			});
		} finally {
			await old.stop(true);
		}
	}
});

test('every answer of serve names its home and version, and a serve of the same version adds no line', async () => {
	const f = await setup();
	const served = await startServe(f);
	try {
		for (const response of [
			await fetch(`${served.base}/`),
			await fetch(`${served.base}/missing/`),
			await fetch(`${served.base}/notes/same`, { method: 'POST', body: '{}' }),
		]) {
			expect(response.headers.get('x-epicenter-home')).toBe(
				encodeURIComponent(f.home),
			);
			expect(response.headers.get('x-epicenter-version')).toBe(VERSION);
			await response.body?.cancel();
		}
		// A tunnel's request is refused before serve says anything about itself.
		const tunnelled = await fetch(`${served.base}/`, {
			headers: { 'cf-connecting-ip': '203.0.113.7' },
		});
		expect(tunnelled.status).toBe(403);
		expect(tunnelled.headers.get('x-epicenter-home')).toBeNull();
		expect(await f.run('notes', 'same', '--json')).toMatchObject({
			code: 0,
			stderr: '',
		});
	} finally {
		await served.stop();
	}
});

test('a second serve says this home is already served, and a port something else holds says to set another', async () => {
	const f = await setup();
	const taken = `Port ${f.port} is in use by another program or another Epicenter. Set a different \`port\` in EPICENTER.md.\n`;
	const served = await startServe(f);
	try {
		expect(await f.run('serve')).toEqual({
			code: 2,
			stdout: '',
			stderr: `Epicenter is already serving this home on port ${f.port}.\n`,
		});
		expect((await fetch(`${served.base}/`)).status).toBe(200);
	} finally {
		await served.stop();
	}
	const elsewhere = await holdPort(
		f,
		() => new Response('', { headers: { 'x-epicenter-home': 'elsewhere' } }),
	);
	try {
		expect(await f.run('serve')).toEqual({
			code: 2,
			stdout: '',
			stderr: taken,
		});
	} finally {
		await elsewhere.stop(true);
	}
	// A program that does not speak HTTP is found only when the port will not bind.
	const silent = Bun.listen({
		hostname: '127.0.0.1',
		port: f.port,
		socket: { open: (socket) => void socket.end(), data() {} },
	});
	try {
		expect(await f.run('serve')).toEqual({
			code: 2,
			stdout: '',
			stderr: taken,
		});
	} finally {
		silent.stop(true);
	}
});

test('C12 runs leave no temporary file and no lock file', async () => {
	const f = await setup();
	const temp = join(f.root, 'tmp');
	await mkdir(temp);
	// The actions run in serve, so serve is what must leave nothing behind.
	const served = await startServe(f, [], {
		env: { ...f.env, TMPDIR: temp },
	});
	try {
		const exits = await Promise.all([
			f.run('notes', 'write', '{"page":"monday"}'),
			f.run('notes', 'write', '{"page":"tuesday"}'),
			f.run('notes', 'half', '{"page":"wednesday"}'),
		]);
		expect(exits.map((run) => run.code)).toEqual([0, 0, 1]);
	} finally {
		await served.stop();
	}
	// macOS Git's launcher keeps its own cache in TMPDIR.
	expect((await readdir(temp)).filter((name) => name !== 'xcrun_db')).toEqual(
		[],
	);
	expect(await readdir(join(f.dir, 'local/.tmp'))).toEqual([]);
});

test('C8 stdout belongs to epicenter: an action that logs does not corrupt --json or an MCP answer', async () => {
	const f = await setup();
	const json = await f.json('notes', 'chatty');
	expect(json.code).toBe(0);
	expect(json.answer).toEqual({ data: 'answer', error: null });
	// The action printed in serve, where it ran, and not in the command.
	expect(json.stderr).toBe('');
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
