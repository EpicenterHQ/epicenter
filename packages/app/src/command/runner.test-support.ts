import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { COMMANDS } from './commands.ts';

const bin = resolve(import.meta.dir, 'bin.ts');

/**
 * A test home's `package.json`: the workspace an Epicenter is, without its
 * dependency, which `bun install` would ask the registry for.
 * `installPackages` puts it in place instead.
 */
export const homePackage = `${JSON.stringify({ private: true, workspaces: ['apps/*/code'] }, null, 2)}\n`;

/**
 * Give the home at `folder` the install a real one gets from `bun install`,
 * without the network: `node_modules/@epicenter/app` links to this
 * repository's package, and `node_modules/.bin/epicenter` to its command.
 * The empty `node_modules/.bun` is what Bun's own install leaves; with it
 * there, a `bun install` a test runs in the home keeps these links.
 */
export async function installPackages(folder: string) {
	const modules = join(folder, 'node_modules');
	await mkdir(join(modules, '.bun'), { recursive: true });
	await mkdir(join(modules, '.bin'));
	await mkdir(join(modules, '@epicenter'));
	const app = resolve(import.meta.dir, '..', '..');
	await symlink(app, join(modules, '@epicenter', 'app'));
	await symlink(
		join('..', '@epicenter', 'app', 'src', 'command', 'bin.ts'),
		join(modules, '.bin', 'epicenter'),
	);
}

/**
 * A port nothing listens on, for a home's `EPICENTER.md`. It is below the
 * range the system hands to outgoing connections, so nothing takes it between
 * this check and the serve that binds it.
 */
export async function freePort() {
	for (;;) {
		const port = 10_000 + Math.floor(Math.random() * 20_000);
		try {
			Bun.listen({
				hostname: '127.0.0.1',
				port,
				socket: { data() {} },
			}).stop(true);
			return port;
		} catch {
			// Taken; try another.
		}
	}
}

type Served = Awaited<ReturnType<typeof spawnServe>>;

/** What a fixture knows of its home's serve. */
type Serving = {
	/** The serve the fixture started for an action, once one was run. */
	own?: Promise<Served>;
	/** How many serves the test started with `startServe` are running. */
	byTest: number;
	/** Whether the test asked for no serve, so the fixture starts none. */
	off: boolean;
};

const fixtures = new Set<Serving>();

/**
 * Stop every serve a fixture started on its own. The preload runs this after
 * each test, so a fixture's serve lasts as long as the test that made it.
 */
export async function stopFixtureServes() {
	await Promise.all(
		[...fixtures].map(async (serving) => {
			const own = serving.own;
			serving.own = undefined;
			// Killed, not asked to stop: a test's home has nothing to finish.
			await (await own?.catch(() => undefined))?.kill();
		}),
	);
	fixtures.clear();
}

/** Whether `args` ask `epicenter` to run an app's action, which needs serve. */
function callsAction(args: string[]) {
	const words = args.filter((arg) => arg !== '--json');
	const [first] = words;
	return (
		words.length > 1 &&
		first !== undefined &&
		!first.startsWith('-') &&
		!Object.hasOwn(COMMANDS, first) &&
		!args.some((arg) => arg === '--help' || arg === '-h')
	);
}

/**
 * A temporary `HOME` whose `Epicenter` folder is the app home, a Bun
 * workspace with its packages in place (`installPackages`), its apps in
 * `apps`, and the real `bin.ts` run against it, so output, exit codes, and the folders on disk are
 * tested together. Nothing here reads the person's own home.
 *
 * Only serve runs an action, so a `run` of one starts `epicenter serve` for
 * this home unless one is running, and it is stopped when the test ends.
 * `serve` starts it without a `run`, for a test that spawns the command
 * itself. While a serve from `startServe` runs, the fixture starts none, and
 * after `stopServe` it starts none again.
 */
export async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-runner-')),
	);
	const home = join(root, 'Epicenter');
	await mkdir(home);
	// A home's port is how its serve is found, so each home has its own.
	const port = await freePort();
	await writeFile(join(home, 'EPICENTER.md'), `---\nport: ${port}\n---\n`);
	await writeFile(join(home, 'package.json'), homePackage);
	await installPackages(home);
	const apps = join(home, 'apps');
	await mkdir(apps);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: root,
		EPICENTER_ROOT: undefined,
	};

	/** Write `files` under `dir`. */
	async function folder(dir: string, files: Record<string, string>) {
		await mkdir(dir, { recursive: true });
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), text);
		}
		return dir;
	}

	/**
	 * An app container at `<epicenter>/apps/<entry>`: its `code/epicenter.ts`
	 * is `source` after an import of everything an app defines itself with.
	 */
	async function app(entry: string, source: string, epicenter = home) {
		return folder(join(epicenter, 'apps', entry), {
			'code/epicenter.ts': `${header}${source}`,
		});
	}

	// As the command's own first line runs it: Bun never fetches a package the home lacks.
	const command = [process.execPath, '--no-install', bin];
	const serving: Serving = { byTest: 0, off: false };
	/** Start this home's serve unless one runs already or the test asked for none. */
	async function serve() {
		if (serving.byTest || serving.off) return;
		fixtures.add(serving);
		if (!serving.own) {
			const own = spawnServe(serving, command, root, env);
			serving.own = own;
			// An action can end serve; the next one starts it again.
			void own
				.then((served) => served.exited)
				.catch(() => undefined)
				.then(() => {
					if (serving.own === own) serving.own = undefined;
				});
		}
		await serving.own;
	}
	/** Stop the serve the fixture started, and start no other. */
	async function stopServe() {
		serving.off = true;
		const own = serving.own;
		serving.own = undefined;
		await (await own?.catch(() => undefined))?.kill();
	}

	async function runIn(cwd: string, ...args: string[]) {
		if (callsAction(args)) await serve();
		const child = Bun.spawn([...command, ...args], {
			cwd,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}
	const run = (...args: string[]) => runIn(root, ...args);
	return {
		root,
		home,
		apps,
		port,
		env,
		bin,
		folder,
		app,
		run,
		runIn,
		serve,
		stopServe,
		serving,
	};
}

/**
 * Start `epicenter serve` for the fixture `f` at its home's port, with Bun's
 * `execArgv` before the entry, and wait until it listens. `base` is its
 * address; `stop` sends SIGTERM and resolves with its exit code; `stderr` is
 * what it has written so far. The serve the fixture started is stopped first,
 * and the fixture starts no other while this one runs. `command` is the
 * `epicenter` to run instead of this source, and `env` its environment.
 */
export async function startServe(
	f: Awaited<ReturnType<typeof fixture>>,
	execArgv: string[] = [],
	{
		command = [process.execPath, '--no-install', ...execArgv, f.bin],
		env = f.env,
	}: { command?: string[]; env?: Record<string, string | undefined> } = {},
) {
	const own = f.serving.own;
	f.serving.own = undefined;
	await (await own?.catch(() => undefined))?.kill();
	return spawnServe(f.serving, command, f.root, env, true);
}

async function spawnServe(
	serving: Serving,
	command: string[],
	cwd: string,
	env: Record<string, string | undefined>,
	byTest = false,
) {
	const child = Bun.spawn([...command, 'serve'], {
		cwd,
		env,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	if (byTest) {
		serving.byTest++;
		void child.exited.then(() => serving.byTest--);
	}
	const ready = Promise.withResolvers<string>();
	let output = '';
	void (async () => {
		const reader = child.stderr.getReader();
		for (;;) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(chunk);
			const port = /Serving your apps at http:\/\/127\.0\.0\.1:(\d+)\./.exec(
				output,
			)?.[1];
			if (port) ready.resolve(`http://127.0.0.1:${port}`);
		}
		ready.reject(new Error(output || 'serve exited before listening'));
	})();
	const stop = async () => {
		child.kill('SIGTERM');
		return child.exited;
	};
	try {
		const base = await Promise.race([
			ready.promise,
			Bun.sleep(10_000).then(() => {
				throw new Error('serve did not listen');
			}),
		]);
		return {
			base,
			exited: child.exited,
			stop,
			kill: async () => {
				child.kill('SIGKILL');
				return child.exited;
			},
			stderr: () => output,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

/**
 * An MCP client connected to a new `epicenter serve` for `f`, as an agent
 * connects. `close` closes the client and stops serve.
 */
export async function connectMcp(
	f: Awaited<ReturnType<typeof fixture>>,
	execArgv: string[] = [],
) {
	const served = await startServe(f, execArgv);
	const client = new Client({ name: 'acceptance', version: '1' });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${served.base}/`)),
		);
	} catch (error) {
		await served.stop();
		throw error;
	}
	return {
		client,
		served,
		close: async () => {
			await client.close();
			await served.stop();
		},
	};
}

/** The import every test app's `epicenter.ts` starts with. */
export const header = `import { defineAction, defineApp, defineData, field, Err, Ok } from '@epicenter/app';\n`;

/** The `epicenter.ts` of an app with only a description that names it. */
export function bareApp(name: string) {
	return `${header}export default defineApp(() => ({ description: 'The ${name} app', actions: {} }));\n`;
}

/** Reading, as an app's files: a books data key and actions that write a CSV. */
export const readingApp = {
	'code/epicenter.ts': `${header}
export default defineApp(({ folder }) => {
const data = defineData(folder, { books: { fields: { title: field.text() } } });

return {
	description: 'How much I read each week',
	data,
	actions: {
		books: data.books.actions('list', 'get', 'create', 'patch'),
		log: defineAction({
			description: 'Record minutes read today',
			input: { minutes: field.number(), book: field.text({ optional: true }) },
			run: async ({ minutes, book }) => {
				await folder.edit('data/2026.csv', (before = 'minutes,book\\n') => Ok({ text: \`\${before}\${minutes},\${book ?? ''}\\n\` }));
				return Ok({ minutes, book: book ?? null });
			},
		}),
		between: defineAction({
			description: 'Minutes read between two days',
			input: { from: field.date(), to: field.date() },
			annotations: { readOnlyHint: true },
			run: ({ from, to }) => Ok(({ from, to })),
		}),
		week: {
			show: defineAction({
				description: 'Minutes read this week',
				input: {},
				annotations: { readOnlyHint: true, openWorldHint: false },
				run: () => Ok(210),
			}),
		},
		explode: defineAction({
			description: 'Write, then throw',
			input: {},
			run: async () => {
				await folder.write('data/2026.csv', 'minutes,book\\n1,\\n');
				throw new Error('line 4 is not a number');
			},
		}),
	},
};
});
`,
};

/** The source of an app with many kinds of input, for `fixture().app`. */
export const reading = `export default defineApp(({ folder }) => ({ description: 'The reading app', actions: {
	log: defineAction({ description: 'Record reading', input: { minutes: field.number(), book: field.text({optional:true}) }, run: async (input) => { await folder.write('data/records/log.json', JSON.stringify(input)); return Ok(input); } }),
	week: { summary: defineAction({ description: 'Weekly minutes', input: {}, annotations: { readOnlyHint: true }, run: () => Ok(({minutes:210})) }) },
	tag: defineAction({ description:'Tag records', input: { tags: field.list(field.text()), done: field.boolean() }, run: (input) => Ok(input) }),
	collect: defineAction({ description:'Collect tags', input: { tags: field.list(field.text()) }, run: (input) => Ok(input) }),
	inspect: defineAction({ description:'Inspect the context', input:{}, run: async () => { await folder.write('local/index.json', '{}'); return Ok({folder:folder.path}); } }),
	explode: defineAction({ description:'Throw an error', input:{}, run: () => {throw new Error('action exploded');} }),
} }));`;

/** The source of an app whose actions share the word `calendar`. */
export const vault = `export default defineApp(() => ({ description: 'The vault app', actions: { calendar: {
	show: defineAction({description:'Show a day',annotations:{readOnlyHint:true,destructiveHint:false},input:{day:field.date()},run:({day})=>Ok(({day}))}),
	add: defineAction({description:'Add a day',input:{day:field.date()},run:({day})=>Ok(({day}))}),
} } }));`;
