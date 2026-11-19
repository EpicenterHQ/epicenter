/**
 * Action call tests.
 * A command sends its action to the Epicenter's serve, the one process that runs
 * actions, and never runs it itself.
 *
 * Key behaviors:
 * - Exit codes and answers are the same through the command and MCP.
 * - Concurrent calls in one serve lose no write and leave no temporary file.
 * - With serve stopped, or another holder on the port, a command is refused and nothing runs.
 * - A second serve says whether this Epicenter or something else has the port.
 */
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
	bareApp,
	connectMcp,
	fixture,
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
export default defineApp(({ folder }) => ({
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
				await folder.write('data/cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
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
}));
`;

const notesApp = {
	'data/a.md': 'base a\n',
	'code/epicenter.ts': notesCode,
};

async function setup() {
	const f = await fixture();
	roots.push(f.userDir);
	const folder = await f.folder(join(f.apps, 'notes'), notesApp);
	const json = async (...args: string[]) => {
		const result = await f.run(...args, '--json');
		return { ...result, answer: JSON.parse(result.stdout) };
	};
	return { ...f, dir: folder, data: join(folder, 'data'), json };
}
test('C7 exit codes: 0 Ok, 2 NotStarted, 1 any other error; an action that exits the process ends serve, and the command answers Unreachable', async () => {
	const f = await setup();
	const tagged = await f.json('notes', 'tagged');
	expect(tagged.code).toBe(1);
	expect(tagged.answer).toEqual({
		data: null,
		error: {
			name: 'Threw',
			message: 'no such page',
			thrown: { name: 'NotFound', message: 'no such page', page: 'x' },
		},
	});

	const noRoute = await f.json('notes', 'no-route');
	expect(noRoute.code).toBe(1);
	expect(noRoute.answer).toEqual({
		data: null,
		error: { name: 'NoRoute', message: 'No route from LAX', airport: 'LAX' },
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
	expect(declined.answer.error).toMatchObject({
		name: 'Refused',
	});
	const thrown = await f.json('notes', 'thrown-refusal');
	expect(thrown.code).toBe(1);
	expect(thrown.answer.error.thrown.name).toBe('Refused');
	expect(thrown.answer).not.toHaveProperty('result');
	const plain = await f.json('notes', 'plain');
	expect(plain.code).toBe(1);
	expect(plain.answer).toEqual({
		data: null,
		error: {
			name: 'Threw',
			message: expect.any(String),
		},
	});
	// Serve runs the action, so an action that exits ends serve, and the
	// command is told the answer never came.
	const exited = await f.json('notes', 'exit');
	expect(exited).toMatchObject({ code: 1, stderr: '' });
	expect(exited.answer).toEqual({
		data: null,
		error: {
			name: 'Unreachable',
			message:
				'The connection to serve ended before the answer; the action may still be running, or may have finished',
		},
	});
	const unknown = await f.json('notes', 'nope');
	expect(unknown.code).toBe(2);
	expect(unknown.answer).toMatchObject({
		data: null,
		error: { name: 'NotStarted', next: 'epicenter notes' },
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

test('C11 concurrent patches of different fields on one file all land', async () => {
	const f = await setup();
	const fields = Array.from({ length: 10 }, (_, i) => `f${i}`);
	await f.folder(join(f.apps, 'many'), {
		'code/epicenter.ts': `${header}
export default defineApp(({ folder }) => {
const data = defineData(folder, { items: { description: 'item', fields: { ${fields.map((key) => `${key}: field.number({ optional: true })`).join(', ')} } } });
return { description: 'Many fields', data, actions: data.items.actions('patch') };
});
`,
		'data/items/one.md': '---\n---\n',
	});
	// Serve runs every action, so ten commands at once are ten calls in one
	// process, and no write is lost between them (ADR-0936).
	const runs = await Promise.all(
		fields.map((key, i) =>
			f.run('many', 'patch', JSON.stringify({ id: 'one', [key]: i })),
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
		'code/epicenter.ts': `${header}
export default defineApp(({ folder }) => ({ description: 'Where', actions: {
	am: defineAction({ description: 'Say which process ran this', input: {}, run: async (_input, update) => {
		await folder.edit('data/ran.txt', (before = '') => Ok({ text: before + 'x' }));
		update('here');
		return Ok(process.pid);
	} }),
} }));
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
		// A request that names another Epicenter is refused before anything runs,
		// and the refusal does not name this one.
		for (const request of [
			fetch(`${served.base}/actions/where/am`, {
				method: 'POST',
				headers: { 'x-epicenter-root': encodeURIComponent('/elsewhere') },
				body: '{}',
			}),
			fetch(`${served.base}/actions/`, {
				headers: {
					'x-epicenter-root': encodeURIComponent('/elsewhere'),
				},
			}),
		]) {
			const other = await request;
			expect(other.status).toBe(409);
			expect(await other.text()).toBe('This call is for another Epicenter');
		}
	} finally {
		await served.stop();
	}
	await f.stopServe();
	expect(await ran()).toBe('xx');
	const message = 'serve is not running; if it stopped, its output says why';
	expect(await f.run('where', 'am')).toEqual({
		code: 2,
		stdout: '',
		stderr: `${message}\nRun: epicenter serve\n`,
	});
	const refused = await f.json('where', 'am');
	expect(refused).toMatchObject({ code: 2, stderr: '' });
	expect(refused.answer).toEqual({
		data: null,
		error: {
			name: 'NotStarted',
			message,
			next: 'epicenter serve',
		},
	});
	expect(await ran()).toBe('xx');
	// Listings and help come from serve too, so each is refused alike.
	for (const words of [[], ['where'], ['where', 'am', '--help']])
		expect((await f.json(...words)).answer.error).toMatchObject({
			message,
		});
});

test('only serve loads app code: the command asks it for the listing, help and calls', async () => {
	const f = await setup();
	const loads = join(f.userDir, 'loads.txt');
	await f.folder(join(f.apps, 'where'), {
		'code/epicenter.ts': `${header}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(loads)}, process.pid + '\\n');
export default defineApp(() => ({ description: 'Where', actions: {
	am: defineAction({ description: 'Say which process ran this', input: {}, run: () => Ok(process.pid) }),
} }));
`,
	});
	for (const words of [[], ['where'], ['where', 'am', '--help']])
		expect((await f.run(...words)).code).toBe(0);
	const inServe = (await f.json('where', 'am')).answer.data;
	const loaders = new Set(
		(await readFile(loads, 'utf8')).trim().split('\n').map(Number),
	);
	expect([...loaders]).toEqual([inServe]);
});

/**
 * What the command prints when serve at its port answers 409 for another
 * Epicenter: it names the folder it took for its Epicenter, and its marker.
 */
function another(port: number, folder: string) {
	return `The serve on port ${port} is another Epicenter's. This command took ${folder} for its Epicenter, from ${join(folder, 'EPICENTER.md')}: if that is not your Epicenter, remove that file; if it is, set a different \`port\` in it.\n`;
}

/** Hold the fixture's port as `answer` does, in place of its serve. */
async function holdPort(
	f: Awaited<ReturnType<typeof setup>>,
	answer: (request: Request) => Response,
) {
	await f.stopServe();
	return Bun.serve({ hostname: '127.0.0.1', port: f.port, fetch: answer });
}

test('a command naming another Epicenter gets 409, runs nothing, and names the folder it took; any other answer is Unreachable', async () => {
	const f = await setup();
	const named: (string | null)[] = [];
	let status = 409;
	const other = await holdPort(f, (request) => {
		named.push(request.headers.get('x-epicenter-root'));
		return new Response('', { status });
	});
	try {
		expect(await f.run('notes', 'write', '{"page":"monday"}')).toEqual({
			code: 2,
			stdout: '',
			stderr: another(f.port, f.epicenter),
		});
		// The command named its root, by its real path, on the one request it made.
		expect(named).toEqual([encodeURIComponent(f.epicenter)]);
		// Another program, or a serve from before an upgrade: said as one message, no probe.
		status = 404;
		expect(await f.run('notes', 'write', '{"page":"monday"}')).toMatchObject({
			code: 1,
			stderr: `The program on port ${f.port} answered 404 Not Found. If it is this Epicenter's serve from before an upgrade, restart it; if it is another program, set another \`port\` in ${join(f.epicenter, 'EPICENTER.md')}.\n`,
		});
		expect(await f.run('--json')).toMatchObject({ code: 1 });
		// A 413 proves nothing ran.
		status = 413;
		expect(await f.run('notes', 'write', '{"page":"monday"}')).toMatchObject({
			code: 2,
			stderr: 'The input is larger than 25 MiB, the most serve takes\n',
		});
	} finally {
		await other.stop(true);
	}
	expect(await Bun.file(join(f.data, 'monday.md')).exists()).toBe(false);
});

test('serve answers 409 to a request for another root, and a body past its limit with 413', async () => {
	const f = await setup();
	const served = await startServe(f);
	try {
		const elsewhere = await fetch(`${served.base}/actions/`, {
			headers: { 'x-epicenter-root': 'elsewhere' },
		});
		expect(elsewhere.status).toBe(409);
		expect(await elsewhere.text()).not.toContain(f.userDir);
		// A tunnel's request is refused before anything else.
		const tunnelled = await fetch(`${served.base}/`, {
			headers: { 'cf-connecting-ip': '203.0.113.7' },
		});
		expect(tunnelled.status).toBe(403);
		const large = await fetch(`${served.base}/actions/notes/same`, {
			method: 'POST',
			body: 'x'.repeat(25 * 1024 * 1024 + 1),
		});
		expect(large.status).toBe(413);
	} finally {
		await served.stop();
	}
});

test('serve exits on SIGTERM while a call is still streaming and an app holds a timer', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app(
		'slow',
		`${header}
setInterval(() => {}, 1000);
export default defineApp(() => ({ description: 'Slow', actions: {
	wait: defineAction({ description: 'Never ends', input: {}, run: async (_, update) => {
		update('started');
		await new Promise(() => {});
		return Ok(null);
	} }),
} }));`,
	);
	const served = await startServe(f);
	const call = await fetch(`${served.base}/actions/slow/wait`, {
		method: 'POST',
		body: '{}',
	});
	const reader = (call.body as ReadableStream<Uint8Array>).getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toContain(
		'started',
	);
	const code = await Promise.race([
		served.stop(),
		Bun.sleep(5000).then(() => 'still running'),
	]);
	expect(code).toBe(0);
	await reader.cancel().catch(() => {});
});

test('an async app function that throws is a problem line, and the other apps still answer', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app('fine', bareApp('fine'));
	await f.app(
		'eager',
		`${header}export default defineApp(async () => { throw new Error('too eager'); });`,
	);
	const served = await startServe(f);
	try {
		await Bun.sleep(100);
		expect(served.stderr()).toContain(
			"\neager: code/epicenter.ts: An app's function must not be async",
		);
		const listed = await fetch(`${served.base}/actions/`);
		expect(
			((await listed.json()) as { apps: { name: string }[] }).apps.map(
				(app) => app.name,
			),
		).toEqual(['fine']);
	} finally {
		await served.stop();
	}
});

/** Serve with `fine` and `thrower`, whose code is `body`; expects serve to still list both apps after `trigger` runs and `thrown` is logged. */
async function survivesThrow(
	body: string,
	thrown: string,
	trigger = async (_base: string) => {},
) {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app('fine', bareApp('fine'));
	await f.app('thrower', `${header}${body}`);
	const served = await startServe(f);
	try {
		await trigger(served.base);
		await Bun.sleep(100);
		expect(served.stderr()).toContain(thrown);
		const listed = await fetch(`${served.base}/actions/`);
		expect(
			((await listed.json()) as { apps: { name: string }[] }).apps.map(
				(app) => app.name,
			),
		).toEqual(['fine', 'thrower']);
	} finally {
		expect(await served.stop()).toBe(0);
	}
}

test('a throw nothing catches in an app timer is logged, and serve keeps serving', () =>
	survivesThrow(
		`export default defineApp(() => {
	setTimeout(() => { throw new Error('timer threw'); });
	return { description: 'Throws', actions: {} };
});`,
		'timer threw',
	));

test('a throw nothing catches after an action answered is logged, and serve keeps serving', () =>
	survivesThrow(
		`export default defineApp(() => ({ description: 'Throws', actions: {
	late: defineAction({ description: 'Throws after answering', input: {}, run: () => {
		queueMicrotask(() => { throw new Error('late threw'); });
		return Ok('answered');
	} }),
} }));`,
		'late threw',
		async (base) => {
			const late = await fetch(`${base}/actions/thrower/late`, {
				method: 'POST',
				body: '{}',
			});
			expect(await late.text()).toContain('answered');
		},
	));

test('a stray EPICENTER.md below the root is an Epicenter, and the refusal names it', async () => {
	const f = await setup();
	// A command finds the nearest marker, as Git finds the nearest .git, so one
	// in an app's data is a root of its own. A stray copied from the real root
	// names the port the real serve holds.
	const stray = f.data;
	await mkdir(stray, { recursive: true });
	await writeFile(join(stray, 'EPICENTER.md'), `---\nport: ${f.port}\n---\n`);
	await f.serve();
	expect(await f.runIn(stray, 'notes', 'write', '{"page":"monday"}')).toEqual({
		code: 2,
		stdout: '',
		stderr: another(f.port, stray),
	});
	expect(await Bun.file(join(f.data, 'monday.md')).exists()).toBe(false);
});

test('a second serve, or any program on the port, stops serve before it loads an app', async () => {
	const f = await setup();
	const taken = `Port ${f.port} is in use. If that is not this Epicenter's serve, set another \`port\` in ${join(f.epicenter, 'EPICENTER.md')}.\n`;
	const served = await startServe(f);
	try {
		expect(await f.run('serve')).toEqual({
			code: 2,
			stdout: '',
			stderr: taken,
		});
		expect((await fetch(`${served.base}/actions/`)).status).toBe(200);
	} finally {
		await served.stop();
	}
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

test('C12 runs leave no temporary file', async () => {
	const f = await setup();
	const temp = join(f.userDir, 'tmp');
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
