// bun packages/cli/prototype/selected-interview/pages-app.demo.ts
// One app in three files (pages-app/), run over HTTP against a disposable copy
// of the Vault page Rewrite Beside the Original. Also runs two contrast apps:
// the same code with nothing registered, and a fielded probe of the real article.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type appDefinition from './pages-app/epicenter';

const cli = process.env.EPICENTER_DEMO_CLI ?? 'epicenter';
assert.equal(
	Bun.spawnSync([cli, '--version']).stdout.toString().trim(),
	'epicenter 0.4.0',
);
const demo = await mkdtemp(join(tmpdir(), 'pages-app-'));
const home = join(demo, 'Epicenter');
await mkdir(home, { recursive: true });
await writeFile(join(home, 'EPICENTER.md'), '');
const env = {
	...process.env,
	EPICENTER_ROOT: home,
	EPICENTER_RUNTIME_DIR: join(demo, 'runtime'),
};

// The author's files, copied as they are; the SDK stand-in replaces its re-export.
const source = join(import.meta.dir, 'pages-app');
async function install(app: string, epicenter?: string) {
	const code = join(home, 'apps', app, 'code');
	await mkdir(join(code, 'node_modules'), { recursive: true });
	for (const name of ['pages.ts', 'page-actions.ts', 'epicenter.ts'])
		await copyFile(join(source, name), join(code, name));
	await copyFile(
		join(import.meta.dir, 'directory.prototype.ts'),
		join(code, 'directory.prototype.ts'),
	);
	if (epicenter) await writeFile(join(code, 'epicenter.ts'), epicenter);
	return join(home, 'apps', app);
}
const app = await install('pages');
const unregistered = await install(
	'unregistered',
	(await readFile(join(source, 'epicenter.ts'), 'utf8')).replace(
		'collectionsOf({ pages })',
		'{}',
	),
);
const probe = await install(
	'probe',
	`import { defineApp, defineCollection, field } from '@epicenter/app';
export default defineApp({
	description: 'Does the real Vault article fit a fielded declaration?',
	collections: {
		articles: defineCollection({
			path: 'data/pages/{page}/article.md',
			fields: { title: field.text() },
		}),
	},
	actions: {},
});
`,
);

// Disposable Vault fixture: the real page, with its script and export rehomed
// into videos/short. Everything else in the page folder stays as undeclared neighbors.
const name = 'rewrite-beside-the-original';
const vault =
	process.env.VAULT_DEMO_PAGES ??
	join(homedir(), 'Epicenter/apps/vault/data/pages');
async function seed(root: string) {
	const page = join(root, 'data/pages', name);
	await cp(join(vault, name), page, { recursive: true });
	await copyFile(join(vault, name + '.md'), join(page, 'article.md'));
	const short = join(page, 'videos/short');
	await mkdir(short, { recursive: true });
	await rename(join(page, 'script.md'), join(short, 'script.md'));
	await copyFile(
		join(page, 'renditions/short-video/direction/a-full.mp4'),
		join(short, 'final.mp4'),
	);
	await mkdir(join(root, 'data/pages/empty-page'), { recursive: true });
	return page;
}
const page = await seed(app);
await seed(unregistered);
await seed(probe);

async function hashes(root: string) {
	const out: Record<string, string> = {};
	for (const f of (await readdir(root, { recursive: true })).sort())
		if ((await stat(join(root, f))).isFile())
			out[f] = createHash('sha256')
				.update(await readFile(join(root, f)))
				.digest('hex')
				.slice(0, 12);
	return out;
}
const before = await hashes(page);
const scriptBefore = await readFile(
	join(page, 'videos/short/script.md'),
	'utf8',
);

const server = Bun.spawn([cli, 'serve', '--host', '127.0.0.1', '--port', '0'], {
	cwd: home,
	env,
	stderr: 'pipe',
	stdout: 'ignore',
});
const reader = server.stderr.getReader();
const log: Record<string, unknown> = {};
const check = (app: string) => {
	const r = Bun.spawnSync([cli, 'check', app, '--json'], { cwd: home, env });
	return {
		exit: r.exitCode,
		report: JSON.parse(r.stdout.toString() || 'null'),
	};
};
try {
	let startup = '';
	while (!/http:\/\/127\.0\.0\.1:\d+\./.test(startup)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(startup);
		startup += new TextDecoder().decode(value);
	}
	const url = startup.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
	const { connect } = (await import(
		join(app, 'code/node_modules/@epicenter/app/src/client.ts')
	)) as typeof import('@epicenter/app/client');
	const api = connect<typeof appDefinition>({ app: 'pages', url }).pages;
	const other = connect<typeof appDefinition>({
		app: 'unregistered',
		url,
	}).pages;
	const ok = <T>(r: { data: T; error: unknown }) => {
		assert.equal(r.error, null, JSON.stringify(r.error));
		return r.data;
	};

	// 1. Location decides the schema: an empty directory is a page too.
	log.pages = ok(await api.list({}));
	assert.deepEqual(log.pages, ['empty-page', name]);
	log.videos = ok(await api.videos({ page: name }));
	assert.deepEqual(log.videos, ['short']);

	// 2. Plain Markdown reads as the text on disk, YAML and all.
	const article = ok(await api.read({ page: name }));
	assert.equal(article, await readFile(join(page, 'article.md'), 'utf8'));
	log.articleFirstLine = String(article).split('\n')[1];

	// 3. Edit the short script in place; a repeat finds nothing to replace.
	const old = '- When I rewrite something,';
	const replacement = '- When I revise a draft,';
	ok(await api.revise({ page: name, old, new: replacement }));
	assert.equal(
		await readFile(join(page, 'videos/short/script.md'), 'utf8'),
		scriptBefore.replace(old, replacement),
	);
	log.repeatEdit = (
		await api.revise({ page: name, old, new: replacement })
	).error?.name;
	assert.equal(log.repeatEdit, 'Changed');

	// 4. Replace the export with the real alternate passage.
	const passage = await readFile(
		join(page, 'renditions/short-video/direction/a-passage.mp4'),
	);
	ok(
		await api.replace({
			page: name,
			video: 'short',
			upload: new File([passage], 'a-passage.mp4', { type: 'video/mp4' }),
		}),
	);
	assert.deepEqual(
		await readFile(join(page, 'videos/short/final.mp4')),
		passage,
	);

	// 5. Optional children: the empty page has no article, no short script.
	assert.equal(ok(await api.read({ page: 'empty-page' })), null);
	log.emptyPageRevise = (
		await api.revise({ page: 'empty-page', old: 'a', new: 'b' })
	).error?.name;
	assert.equal(log.emptyPageRevise, 'Missing');

	// 6. A review is optional; a present one must fit. A bad one is local to it.
	assert.equal(ok(await api.review({ page: name, video: 'short' })), null);
	const review = join(page, 'videos/short/review.md');
	await writeFile(review, 'No title yet.\n');
	await writeFile(
		join(unregistered, 'data/pages', name, 'videos/short/review.md'),
		'No title yet.\n',
	);
	log.badReview = (
		await api.review({ page: name, video: 'short' })
	).error?.name;
	assert.equal(log.badReview, 'Misfit');
	log.unregisteredBadReview = (
		await other.review({ page: name, video: 'short' })
	).error?.name;
	assert.equal(log.unregisteredBadReview, 'Misfit');
	ok(await api.read({ page: name })); // the article stays readable

	// 7. What registration enables: `epicenter check` sees the bad review only
	//    when the app registered the directory.
	log.checkRegistered = check('pages');
	log.checkUnregistered = check('unregistered');
	log.checkProbe = check('probe');
	await rm(review);

	const after = await hashes(page);
	log.changed = Object.keys(after).filter((f) => after[f] !== before[f]);
	assert.deepEqual(log.changed, [
		'videos/short/final.mp4',
		'videos/short/script.md',
	]);
	assert.deepEqual(Object.keys(after), Object.keys(before));
	log.scriptDiff = Bun.spawnSync(
		[
			'diff',
			'-u',
			'--label',
			'script.md (before)',
			'--label',
			'script.md (after)',
			'-',
			join(page, 'videos/short/script.md'),
		],
		{ stdin: Buffer.from(scriptBefore) },
	).stdout.toString();
	log.tree = Object.keys(after);
	await writeFile(
		join(demo, 'pages-app-proof.json'),
		JSON.stringify(log, null, 2),
	);
	console.log(JSON.stringify(log, null, 2));
	console.log('Verified on disk:', page);
} finally {
	server.kill('SIGTERM');
	await server.exited;
	reader.releaseLock();
}
