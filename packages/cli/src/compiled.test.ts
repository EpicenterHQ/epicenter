/**
 * The compiled `epicenter` (`scripts/compile.ts`) carries `@epicenter/app`
 * and writes it out for an app's tools: a UI bundled from `ui/index.html`
 * resolves `@epicenter/app/client` through the link to that copy, with no
 * source checkout to fall back on. Compiling takes several seconds, so
 * these tests share one compiled binary.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	fixture,
	gitIn,
	gitignore,
	header,
	startServe,
} from './runner.test-support.ts';
import { writingSource } from './writing.test-support.ts';

setDefaultTimeout(120_000);

let dir: string;
let bin: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'epicenter-compiled-'));
	bin = join(dir, 'epicenter');
	const compile = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, '..', 'scripts', 'compile.ts'),
			'--outfile',
			bin,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	if ((await compile.exited) !== 0)
		throw new Error(await new Response(compile.stderr).text());
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test('compiled export refreshes a collection without importing app code or copying private records', async () => {
	const f = await fixture();
	try {
		await f.folder(
			f.home,
			{
				'apps/tasks/code/epicenter.ts':
					'throw new Error("export must not import me");',
				'apps/tasks/data/private.md': 'private record',
			},
			{ git: true },
		);
		const destination = join(f.root, 'shared-apps');
		for (const refresh of [false, true]) {
			const child = Bun.spawn([bin, 'export', '--all', destination, '--json'], {
				cwd: f.home,
				env: f.env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
			expect(JSON.parse(stdout)).toMatchObject({
				directory: destination,
				apps: [{ app: 'tasks' }],
			});
			expect(
				await Bun.file(join(destination, 'tasks/data/private.md')).exists(),
			).toBe(false);
			if (!refresh) {
				await writeFile(join(f.apps, 'tasks/code/added.txt'), 'added');
				await gitIn(f.home, 'add', '--', 'apps/tasks/code/added.txt');
				await gitIn(
					f.home,
					'commit',
					'--no-verify',
					'-qm',
					'next code snapshot',
				);
			}
		}
		expect(await readFile(join(destination, 'tasks/added.txt'), 'utf8')).toBe(
			'added',
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('the compiled binary copies and builds a writing app from Git without Bun on PATH', async () => {
	const f = await fixture();
	const env = {
		...f.env,
		PATH: '/usr/bin:/bin',
		XDG_DATA_HOME: join(f.root, 'xdg-data'),
	};
	const run = async (...words: string[]) => {
		const child = Bun.spawn([bin, ...words], {
			cwd: f.root,
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
	};
	// The compiled serve runs the actions, with no Bun on its PATH either.
	const served = await startServe(f, [], { command: [bin], env });
	try {
		expect(
			(
				await run(
					'new',
					'writing',
					'--from',
					join(await writingSource(f), 'writing'),
				)
			).code,
		).toBe(0);
		expect(
			(
				await run(
					'writing',
					'add',
					'{"body":"A note from the compiled starter"}',
				)
			).code,
		).toBe(0);
		const found = await run(
			'writing',
			'search',
			'{"query":"compiled starter"}',
			'--json',
		);
		expect(found.code).toBe(0);
		expect(JSON.parse(found.stdout).data).toMatchObject([
			{ body: 'A note from the compiled starter', kind: 'thought' },
		]);
		const built = await run('build', 'writing');
		expect(built).toEqual({
			code: 0,
			stdout: 'writing: UI built\n',
			stderr: '',
		});
		expect(
			await readFile(join(f.apps, 'writing/code/ui/dist/index.html'), 'utf8'),
		).toContain('Writing inbox');
	} finally {
		await served.stop();
		await rm(f.root, { recursive: true, force: true });
	}
});

test('a compiled epicenter writes out the @epicenter/app it carries and builds a UI against it', async () => {
	const f = await fixture();
	try {
		const app = await f.folder(join(f.apps, 'vocab'), {
			'code/.gitignore': `${gitignore}ui/dist/\n`,
			'code/epicenter.ts': `${header}export default defineApp({ description: 'Words', actions: { hello: defineAction({ description: 'Hello', input: {}, run: () => Ok('hi') }) } });\n`,
			'code/ui/index.html':
				'<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
			'code/ui/main.ts':
				"import { connect } from '@epicenter/app/client';\ndocument.body.dataset.client = String(connect);\n",
		});
		const data = join(f.root, 'xdg-data');
		const run = Bun.spawn([bin, 'build', 'vocab'], {
			cwd: f.root,
			env: { ...f.env, XDG_DATA_HOME: data },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
			run.exited,
		]);
		expect({ code, stdout, stderr }).toEqual({
			code: 0,
			stdout: 'vocab: UI built\n',
			stderr: '',
		});
		const link = await readlink(
			join(app, 'code', 'node_modules', '@epicenter', 'app'),
		);
		expect(await realpath(link)).toStartWith(
			await realpath(join(data, 'epicenter', 'app')),
		);
		expect(
			JSON.parse(await readFile(join(link, 'package.json'), 'utf8')).exports,
		).toEqual({
			'.': './src/index.ts',
			'./client': './src/client.ts',
			'./testing': './src/testing.ts',
		});
		const html = await readFile(
			join(app, 'code', 'ui', 'dist', 'index.html'),
			'utf8',
		);
		expect(html).toMatch(/src="\.\/[^"]+\.js"/);
		const env = { ...f.env, XDG_DATA_HOME: data };
		const served = await startServe(f, [], { command: [bin], env });
		try {
			const hello = Bun.spawn([bin, 'vocab', 'hello', '--json'], {
				cwd: f.root,
				env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(await new Response(hello.stdout).text()).toBe(
				'{"data":"hi","error":null}\n',
			);
		} finally {
			await served.stop();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test("a compiled epicenter runs an app whose package names its entry only in package.json's exports", async () => {
	const f = await fixture();
	try {
		// No `index.js` at the package's root, as with any package built into
		// `dist/`: only its `package.json` says where the entry is.
		await f.folder(join(f.apps, 'vocab'), {
			'code/epicenter.ts': `${header}import { greeting } from 'greeting';\nexport default defineApp({ description: 'Words', actions: { hello: defineAction({ description: 'Hello', input: {}, run: () => Ok(greeting) }) } });\n`,
			'code/node_modules/greeting/package.json': `${JSON.stringify({ name: 'greeting', type: 'module', exports: { '.': './dist/main.js' } })}\n`,
			'code/node_modules/greeting/dist/main.js':
				"export const greeting = 'hi';\n",
		});
		const env = { ...f.env, XDG_DATA_HOME: join(f.root, 'xdg-data') };
		const served = await startServe(f, [], { command: [bin], env });
		try {
			const hello = Bun.spawn([bin, 'vocab', 'hello', '--json'], {
				cwd: f.root,
				env,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(hello.stdout).text(),
				new Response(hello.stderr).text(),
				hello.exited,
			]);
			expect({ code, stdout, stderr }).toEqual({
				code: 0,
				stdout: '{"data":"hi","error":null}\n',
				stderr: '',
			});
		} finally {
			await served.stop();
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('serve relinks each app to the @epicenter/app it carries, and a UI built against another one rebuilds on its next page load', async () => {
	const f = await fixture();
	try {
		const app = await f.folder(join(f.apps, 'vocab'), {
			'code/.gitignore': `${gitignore}ui/dist/\n`,
			'code/epicenter.ts': `${header}export default defineApp({ description: 'Words', actions: {} });\n`,
			'code/package.json': `${JSON.stringify({ scripts: { build: `mkdir -p "$EPICENTER_OUT" && bun -e "console.log(Bun.fileURLToPath(import.meta.resolve('@epicenter/app/client')))" > "$EPICENTER_OUT/index.html"` } })}\n`,
			'code/ui/.keep': '',
		});
		const before = join(f.root, 'data-before');
		const after = join(f.root, 'data-after');
		const built = Bun.spawn([bin, 'build', 'vocab'], {
			cwd: f.root,
			env: { ...f.env, XDG_DATA_HOME: before },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(await built.exited).toBe(0);
		const page = () =>
			readFile(join(app, 'code', 'ui', 'dist', 'index.html'), 'utf8');
		expect(await realpath((await page()).trim())).toStartWith(
			await realpath(before),
		);

		const serve = Bun.spawn([bin, 'serve'], {
			cwd: f.root,
			env: { ...f.env, XDG_DATA_HOME: after },
			stdout: 'ignore',
			stderr: 'pipe',
		});
		try {
			let output = '';
			const reader = serve.stderr.getReader();
			let base: string | undefined;
			while (!base) {
				const { value, done } = await reader.read();
				if (done) throw new Error(output);
				output += new TextDecoder().decode(value);
				base = /Serving your apps at (http:\/\/127\.0\.0\.1:\d+)\./.exec(
					output,
				)?.[1];
			}
			expect(
				await realpath(
					await readlink(
						join(app, 'code', 'node_modules', '@epicenter', 'app'),
					),
				),
			).toStartWith(await realpath(after));
			await fetch(`${base}/vocab/`);
			let rebuilt = false;
			for (let tries = 0; tries < 100 && !rebuilt; tries++) {
				rebuilt = (await realpath((await page()).trim())).startsWith(
					await realpath(after),
				);
				if (!rebuilt) await Bun.sleep(100);
			}
			expect(rebuilt).toBe(true);
		} finally {
			serve.kill('SIGTERM');
			await serve.exited;
		}
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('compiled routines invoke their own CLI and Bun runtime without depending on PATH', async () => {
	const f = await fixture();
	let served: Awaited<ReturnType<typeof startServe>> | undefined;
	try {
		await f.app(
			'hello',
			`export default defineApp({ description: 'Hello', actions: {
			greet: defineAction({ description: 'Hello', input: {}, run: () => Ok('compiled action') })
		} });`,
		);
		await mkdir(join(f.home, 'routines'));
		for (const [name, run] of [
			['action', ['epicenter', 'hello', 'greet']],
			['runtime', ['bun', '-e', 'console.log("compiled runtime")']],
		] as const)
			await writeFile(
				join(f.home, `routines/${name}.md`),
				`---\ncron: "* * * * *"\nrun: ${JSON.stringify(run)}\n---\n`,
			);
		// Routines inherit serve's output, and the first check is a minute after start.
		const serve = Bun.spawn([bin, 'serve'], {
			cwd: f.home,
			env: {
				...f.env,
				PATH: '/usr/bin:/bin',
				XDG_DATA_HOME: join(f.root, 'xdg-data'),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		try {
			let printed = '';
			const reader = serve.stdout.getReader();
			const deadline = Date.now() + 90_000;
			while (
				!(
					printed.includes('compiled action') &&
					printed.includes('compiled runtime')
				)
			) {
				if (Date.now() > deadline)
					throw new Error(`Routines printed only:\n${printed}`);
				const { value, done } = await reader.read();
				if (done) break;
				printed += new TextDecoder().decode(value);
			}
			expect(printed).toContain('compiled action');
			expect(printed).toContain('compiled runtime');
		} finally {
			serve.kill('SIGTERM');
			await serve.exited;
		}
	} finally {
		await served?.stop();
		await rm(f.root, { recursive: true, force: true });
	}
}, 120_000);
