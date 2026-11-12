/**
 * UI build tests: `epicenter build` builds an app's UI from its sources as
 * they sit on disk into `ui/dist/`, and a failed build leaves the last one in
 * place. `serve`'s rebuilding is in `acceptance.http.test.ts`.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn, gitignore, header } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** An app's `package.json` whose `build` runs `script`, with no dependency to install. */
function appPackage(script: string) {
	return `${JSON.stringify({ name: 'vocab', private: true, scripts: { build: script } })}\n`;
}
const writes = (label: string) =>
	appPackage(
		`mkdir -p "$EPICENTER_OUT" && echo ${label} > "$EPICENTER_OUT/index.html"`,
	);

/** A committed app `vocab` holding `files`, with a `ui/` folder. */
async function vocab(files: Record<string, string>) {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.apps, 'vocab'), {
		'.gitignore': `${gitignore}ui/dist/\n`,
		'epicenter.ts': `${header}export default defineApp({ description: 'Words', collections: {}, actions: {} });\n`,
		...files,
	});
	await mkdir(join(app, 'ui'), { recursive: true });
	const ui = () => readFile(join(app, 'ui', 'dist', 'index.html'), 'utf8');
	return { ...f, app, ui };
}

test('build builds the sources as they sit on disk, committed or not, and leaves nothing behind', async () => {
	const f = await vocab({ 'package.json': writes('one') });
	await writeFile(join(f.app, 'package.json'), writes('uncommitted'));
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	expect(built.stdout).toBe('vocab: UI built\n');
	expect(await f.ui()).toBe('uncommitted\n');
	expect(
		await readFile(join(f.app, 'ui', 'dist', '.epicenter-build'), 'utf8'),
	).toMatch(/^[0-9a-f]{64}$/);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('M package.json');
	expect(
		(await readdir(f.home)).filter((name) => name.startsWith('.')),
	).toEqual([]);
});

test('a build script runs in the app folder and is never told where its UI is served', async () => {
	const f = await vocab({
		'package.json': appPackage(
			'mkdir -p "$EPICENTER_OUT" && { pwd; echo "${EPICENTER_BASE:-none}"; } > "$EPICENTER_OUT/index.html"',
		),
	});
	expect((await f.run('build', 'vocab')).code).toBe(0);
	expect(await f.ui()).toBe(`${await realpath(f.app)}\nnone\n`);
});

test("a build resolves @epicenter/app to this command's own", async () => {
	const f = await vocab({
		'package.json': appPackage(
			`mkdir -p "$EPICENTER_OUT" && bun -e "console.log(Bun.fileURLToPath(import.meta.resolve('@epicenter/app/client')))" > "$EPICENTER_OUT/index.html"`,
		),
	});
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const own = join(import.meta.dir, '..', '..', 'app', 'src', 'client.ts');
	expect(await realpath((await f.ui()).trim())).toBe(await realpath(own));
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
});

test('a ui/ with no build script is bundled from its index.html, with relative paths', async () => {
	const f = await vocab({
		'ui/index.html':
			'<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
		'ui/main.ts':
			"import { connect } from '@epicenter/app/client';\ndocument.body.dataset.client = typeof connect;\n",
	});
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const html = await f.ui();
	expect(html).toMatch(/src="\.\/[^"]+\.js"/);
	expect(html).not.toContain('main.ts');
});

test('a failed build keeps the last UI and says why', async () => {
	const f = await vocab({ 'package.json': writes('one') });
	expect((await f.run('build', 'vocab')).code).toBe(0);
	await writeFile(join(f.app, 'package.json'), appPackage('exit 7'));
	const failed = await f.run('build', 'vocab');
	expect(failed.code).toBe(1);
	expect(failed.stderr).toContain('exited 7');
	expect(await f.ui()).toBe('one\n');

	await writeFile(join(f.app, 'package.json'), appPackage('true'));
	const empty = await f.run('build', 'vocab');
	expect(empty.code).toBe(1);
	expect(empty.stderr).toContain('EPICENTER_OUT');
	expect(await f.ui()).toBe('one\n');
});

test('an app whose packages are not installed is not built, and is told to install them', async () => {
	const f = await vocab({
		'package.json': `${JSON.stringify({ name: 'vocab', dependencies: { 'left-pad': '1.3.0' }, scripts: { build: 'exit 9' } })}\n`,
	});
	const built = await f.run('build', 'vocab');
	expect(built.code).toBe(1);
	expect(built.stderr).toContain('epicenter install vocab');
	expect(built.stderr).not.toContain('exited 9');
});

test('an app with no ui/ has nothing to build', async () => {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.apps, 'vocab'), {
		'.gitignore': gitignore,
		'epicenter.ts': `${header}export default defineApp({ description: 'Words', collections: {}, actions: {} });\n`,
	});
	const built = await f.run('build', 'vocab', '--json');
	expect(built.code).toBe(0);
	expect(JSON.parse(built.stdout).apps).toEqual([
		{ app: 'vocab', folder: app, built: false },
	]);
});
