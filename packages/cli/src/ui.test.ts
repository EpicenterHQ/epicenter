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
import { fixture, gitignore, header } from './runner.test-support.ts';

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

/** An app container holding code files and a code/ui/ folder. */
async function vocab(files: Record<string, string>) {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.apps, 'vocab'), {
		'code/.gitignore': `${gitignore}ui/dist/\n`,
		'code/epicenter.ts': `${header}export default defineApp({ description: 'Words', actions: {} });\n`,
		...files,
	});
	await mkdir(join(app, 'code', 'ui'), { recursive: true });
	const ui = () =>
		readFile(join(app, 'code', 'ui', 'dist', 'index.html'), 'utf8');
	return { ...f, app, ui };
}

test('build builds the sources as they sit on disk, committed or not, and leaves nothing behind', async () => {
	const f = await vocab({ 'code/package.json': writes('one') });
	await writeFile(join(f.app, 'code/package.json'), writes('uncommitted'));
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	expect(built.stdout).toBe('vocab: UI built\n');
	expect(await f.ui()).toBe('uncommitted\n');
	expect(
		await readFile(
			join(f.app, 'code', 'ui', 'dist', '.epicenter-build'),
			'utf8',
		),
	).toMatch(/^[0-9a-f]{64}$/);

	expect(
		(await readdir(f.home)).filter((name) => name.startsWith('.')),
	).toEqual([]);
});

test('a build script runs in code/ and is never told where its UI is served', async () => {
	const f = await vocab({
		'code/package.json': appPackage(
			'mkdir -p "$EPICENTER_OUT" && { pwd; echo "${EPICENTER_BASE:-none}"; } > "$EPICENTER_OUT/index.html"',
		),
	});
	expect((await f.run('build', 'vocab')).code).toBe(0);
	expect(await f.ui()).toBe(`${await realpath(join(f.app, 'code'))}\nnone\n`);
});

test("a build resolves @epicenter/app to this command's own", async () => {
	const f = await vocab({
		'code/package.json': appPackage(
			`mkdir -p "$EPICENTER_OUT" && bun -e "console.log(Bun.fileURLToPath(import.meta.resolve('@epicenter/app/client')))" > "$EPICENTER_OUT/index.html"`,
		),
	});
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const own = join(import.meta.dir, '..', '..', 'app', 'src', 'client.ts');
	expect(await realpath((await f.ui()).trim())).toBe(await realpath(own));
});

test('a ui/ with no build script is bundled from its index.html, with relative paths', async () => {
	const f = await vocab({
		'code/ui/index.html':
			'<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
		'code/ui/main.ts':
			"import { connect } from '@epicenter/app/client';\ndocument.body.dataset.client = typeof connect;\n",
	});
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const html = await f.ui();
	expect(html).toMatch(/src="\.\/[^"]+\.js"/);
	expect(html).not.toContain('main.ts');
});

test('a failed build keeps the last UI and says why', async () => {
	const f = await vocab({ 'code/package.json': writes('one') });
	expect((await f.run('build', 'vocab')).code).toBe(0);
	await writeFile(join(f.app, 'code/package.json'), appPackage('exit 7'));
	const failed = await f.run('build', 'vocab');
	expect(failed.code).toBe(1);
	expect(failed.stderr).toContain('exited 7');
	expect(await f.ui()).toBe('one\n');

	await writeFile(join(f.app, 'code/package.json'), appPackage('true'));
	const empty = await f.run('build', 'vocab');
	expect(empty.code).toBe(1);
	expect(empty.stderr).toContain('EPICENTER_OUT');
	expect(await f.ui()).toBe('one\n');
});

test('an app that names packages is not built in a home with no install, and is told to install', async () => {
	const f = await vocab({
		'code/package.json': `${JSON.stringify({ name: 'vocab', dependencies: { 'left-pad': '1.3.0' }, scripts: { build: 'exit 9' } })}\n`,
	});
	await rm(join(f.home, 'node_modules'), { recursive: true });
	const built = await f.run('build', 'vocab');
	expect(built.code).toBe(1);
	expect(built.stderr).toContain(`Run: cd ${f.home} && bun install\n`);
	expect(built.stderr).not.toContain('exited 9');
});

test('an app with no ui/ has nothing to build', async () => {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.apps, 'vocab'), {
		'code/.gitignore': gitignore,
		'code/epicenter.ts': `${header}export default defineApp({ description: 'Words', actions: {} });\n`,
	});
	const built = await f.run('build', 'vocab', '--json');
	expect(built.code).toBe(0);
	expect(JSON.parse(built.stdout).apps).toEqual([
		{ app: 'vocab', folder: join(app, 'code'), built: false },
	]);
});
