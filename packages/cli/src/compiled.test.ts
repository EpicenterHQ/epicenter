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
