/**
 * The compiled `epicenter` (`scripts/compile.ts`) carries `@epicenter/app`
 * and writes it out for an app's tools: a UI bundled from `ui/index.html`
 * resolves `@epicenter/app/client` through the link to that copy, with no
 * source checkout to fall back on. Compiling takes several seconds, so this
 * is the one test that runs the binary.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readFile, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, gitignore, header } from './runner.test-support.ts';

setDefaultTimeout(120_000);

let dir: string;
let bin: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'epicenter-compiled-'));
	bin = join(dir, 'epicenter');
	const compile = Bun.spawn(
		[process.execPath, join(import.meta.dir, '..', 'scripts', 'compile.ts'), '--outfile', bin],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	if ((await compile.exited) !== 0)
		throw new Error(await new Response(compile.stderr).text());
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test('a compiled epicenter writes out the @epicenter/app it carries and builds a UI against it', async () => {
	const f = await fixture();
	try {
		const app = await f.folder(join(f.home, 'vocab'), {
			'.gitignore': `${gitignore}ui/dist/\n`,
			'epicenter.ts': `${header}export default defineApp({ description: 'Words', collections: {}, actions: { hello: defineAction({ description: 'Hello', input: {}, run: () => 'hi' }) } });\n`,
			'ui/index.html':
				'<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
			'ui/main.ts':
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
		const link = await readlink(join(app, 'node_modules', '@epicenter', 'app'));
		expect(await realpath(link)).toStartWith(
			await realpath(join(data, 'epicenter', 'app')),
		);
		expect(
			JSON.parse(await readFile(join(link, 'package.json'), 'utf8')).exports,
		).toEqual({ '.': './src/index.ts', './client': './src/client.ts' });
		const html = await readFile(join(app, 'ui', 'dist', 'index.html'), 'utf8');
		expect(html).toMatch(/src="\.\/[^"]+\.js"/);
		const hello = Bun.spawn([bin, 'vocab', 'hello', '--json'], {
			cwd: f.root,
			env: { ...f.env, XDG_DATA_HOME: data },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(await new Response(hello.stdout).text()).toBe('{"returned":"hi"}\n');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

test('serve relinks each app to the @epicenter/app it carries, and a UI built against another one rebuilds on its next page load', async () => {
	const f = await fixture();
	try {
		const app = await f.folder(join(f.home, 'vocab'), {
			'.gitignore': `${gitignore}ui/dist/\n`,
			'epicenter.ts': `${header}export default defineApp({ description: 'Words', collections: {}, actions: {} });\n`,
			'package.json': `${JSON.stringify({ scripts: { build: `mkdir -p "$EPICENTER_OUT" && bun -e "console.log(Bun.fileURLToPath(import.meta.resolve('@epicenter/app/client')))" > "$EPICENTER_OUT/index.html"` } })}\n`,
			'ui/.keep': '',
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
		const page = () => readFile(join(app, 'ui', 'dist', 'index.html'), 'utf8');
		expect(await realpath((await page()).trim())).toStartWith(
			await realpath(before),
		);

		const serve = Bun.spawn([bin, 'serve', '--port', '0'], {
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
				base = /Serving your apps at (http:\/\/127\.0\.0\.1:\d+)\./.exec(output)?.[1];
			}
			expect(
				await realpath(await readlink(join(app, 'node_modules', '@epicenter', 'app'))),
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
