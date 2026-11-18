// bun packages/cli/prototype/selected-interview/demo.ts [--step]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type appDefinition from './interview.prototype';

const cli = process.env.EPICENTER_DEMO_CLI ?? 'epicenter';
const version = Bun.spawnSync([cli, '--version']).stdout.toString().trim();
assert.equal(version, 'epicenter 0.4.0');
const demo = await mkdtemp(join(tmpdir(), 'selected-interview-'));
const home = join(demo, 'Epicenter');
const app = join(home, 'apps', 'interviews');
const code = join(app, 'code');
await mkdir(join(code, 'node_modules'), { recursive: true });
await writeFile(join(home, 'EPICENTER.md'), '');
await copyFile(
	join(import.meta.dir, 'interview.prototype.ts'),
	join(code, 'epicenter.ts'),
);
await copyFile(
	join(import.meta.dir, 'directory.prototype.ts'),
	join(code, 'directory.prototype.ts'),
);
await copyFile(
	join(import.meta.dir, 'takes.prototype.ts'),
	join(code, 'takes.prototype.ts'),
);
await copyFile(
	join(import.meta.dir, 'vault.prototype.ts'),
	join(code, 'vault.prototype.ts'),
);
await copyFile(
	join(import.meta.dir, 'page-entries.prototype.ts'),
	join(code, 'page-entries.prototype.ts'),
);
const server = Bun.spawn([cli, 'serve', '--host', '127.0.0.1', '--port', '0'], {
	cwd: home,
	env: {
		...process.env,
		EPICENTER_ROOT: home,
		EPICENTER_RUNTIME_DIR: join(demo, 'runtime'),
	},
	stderr: 'pipe',
	stdout: 'ignore',
});
const reader = server.stderr.getReader();
const evidence: object[] = [];
const terminal = process.argv.includes('--step')
	? createInterface({ input: process.stdin, output: process.stdout })
	: undefined;
try {
	let startup = '';
	while (!/http:\/\/127\.0\.0\.1:\d+\./.test(startup)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(startup);
		startup += new TextDecoder().decode(value);
	}
	const url = startup.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
	const { connect } = (await import(
		join(code, 'node_modules/@epicenter/app/src/client.ts')
	)) as typeof import('@epicenter/app/client');
	const api = connect<typeof appDefinition>({ app: 'interviews', url });
	function ok<T>(r: { data: T; error: unknown }) {
		assert.equal(r.error, null, JSON.stringify(r.error));
		return r.data;
	}
	if (process.argv.includes('--page-entries')) {
		const root = join(app, 'data/pages');
		await mkdir(join(root, 'lee'), { recursive: true });
		const writeDocument = (text: string) =>
			writeFile(join(root, 'lee.md'), text);
		const writeArticle = (text: string) =>
			writeFile(join(root, 'lee/article.md'), text);
		const document = '---\nsummary: "Interview notes"\n---\nLee.\n';
		const article = '---\ntitle: "Lee"\n---\nArticle.\n';
		await writeDocument(document);
		const archive = join(app, 'data/archive');
		await mkdir(join(archive, 'lee'), { recursive: true });
		await writeFile(join(archive, 'lee.md'), document);
		const snapshots: object[] = [];
		async function compare(
			step: string,
			docState: string,
			articleState: string,
		) {
			const expected = {
				documents: [{ path: 'data/pages/lee.md', state: docState }],
				folders: [{ name: 'lee', article: articleState }],
			};
			const separate = ok(await api.entries.separate({}));
			assert.deepEqual(separate, expected);
			assert.deepEqual(ok(await api.entries.grouped({})), separate);
			assert.deepEqual(ok(await api.entries.directory({})), separate);
			assert.deepEqual(ok(await api.entries.archive({})), {
				documents: [{ path: 'data/archive/lee.md', state: 'valid' }],
				folders: [{ name: 'lee', article: 'absent' }],
			});
			snapshots.push({ step, ...expected });
			console.log(step, JSON.stringify(expected));
		}
		for (const shelf of ['first', 'second']) {
			const shelfPath = join(app, 'data/shelves', shelf);
			await mkdir(join(shelfPath, 'lee'), { recursive: true });
			await writeFile(
				join(shelfPath, 'lee.md'),
				shelf === 'first' ? document : article,
			);
			await writeFile(
				join(shelfPath, 'lee/article.md'),
				shelf === 'first' ? article : document,
			);
		}
		for (const shelf of ['first', 'second']) {
			assert.deepEqual(ok(await api.entries.shelf({ shelf })), {
				documents: [
					{
						path: `data/shelves/${shelf}/lee.md`,
						state: shelf === 'first' ? 'valid' : 'Misfit',
					},
				],
				folders: [
					{ name: 'lee', article: shelf === 'first' ? 'valid' : 'Misfit' },
				],
			});
		}
		await compare('Valid document, empty folder', 'valid', 'absent');
		ok(await api.entries.edit({ name: 'lee', old: 'Lee.', new: 'Archived.' }));
		assert.equal(
			await readFile(join(archive, 'lee.md'), 'utf8'),
			document.replace('Lee.', 'Archived.'),
		);
		assert.equal(await readFile(join(root, 'lee.md'), 'utf8'), document);
		await writeArticle(article);
		await compare('Two valid files', 'valid', 'valid');
		await writeDocument(article); // A title satisfies the article schema only.
		await compare('Wrong schema on direct document', 'Misfit', 'valid');
		await writeDocument(document);
		await writeArticle(document);
		await compare('Wrong schema on nested article', 'valid', 'Misfit');
		await writeFile(
			join(demo, 'page-entries.json'),
			JSON.stringify(snapshots, null, 2),
		);
		// Keep the trial tree available and free data/pages for the existing scenarios.
		await (await import('node:fs/promises')).rename(
			root,
			join(demo, 'page-entries-fixture'),
		);
	}
	const key = { interview: 'lee' };
	const fixtures = join(import.meta.dir, 'fixtures');
	async function upload(name: string, type: string) {
		return new File([await readFile(join(fixtures, name))], name, { type });
	}
	const audio = await upload('take-1.m4a', 'audio/mp4');
	const pdf = await upload('signed-form.pdf', 'application/pdf');
	const base = join(app, 'data/interviews');
	async function snapshot(step: string, id = 'lee') {
		const dir = join(base, id);
		const files: Record<string, string> = {};
		for (const name of (await readdir(dir, { recursive: true })).sort()) {
			if (!(await stat(join(dir, name))).isFile()) continue;
			files[name] = createHash('sha256')
				.update(await readFile(join(dir, name)))
				.digest('hex');
		}
		const markdown =
			'notes.md' in files
				? await readFile(join(dir, 'notes.md'), 'utf8')
				: null;
		const view = {
			step,
			interviews: ok(await api.list({})),
			folder: id,
			files,
			markdown,
		};
		evidence.push(view);
		await writeFile(
			join(demo, 'snapshots.json'),
			JSON.stringify(evidence, null, 2),
		);
		console.log(
			step,
			JSON.stringify(view.interviews),
			Object.keys(files),
			markdown ?? '',
		);
		if (terminal) await terminal.question('Enter to continue ');
		return files;
	}
	ok(await api.record({ ...key, audio }));
	assert.deepEqual(ok(await api.list({})), ['lee']);
	assert.deepEqual(ok(await api.inspect(key)), {
		recordings: ['take-1.m4a'],
		notes: null,
	});
	const first = await snapshot('1 Recording only');
	assert.deepEqual(Object.keys(first), ['recordings/take-1.m4a']);
	ok(await api.consent({ ...key, pdf }));
	assert.ok((await api.consent({ ...key, pdf })).error);
	await snapshot('2 Added signed-form.pdf as consent.pdf');
	ok(
		await api.write({
			...key,
			title: 'Interview with Lee',
			body: 'Lee joined in 2018.\n',
		}),
	);
	await snapshot('3 Created notes');
	ok(await api.correct({ ...key, old: 'in 2018', new: 'in 2019' }));
	assert.match(
		await readFile(join(base, 'lee/notes.md'), 'utf8'),
		/Lee joined in 2019\./,
	);
	await snapshot('4 Corrected notes');
	await writeFile(join(base, 'lee/sketch.txt'), 'Outside the schema.\n');
	const before = await snapshot('5 Added an undeclared neighbor');
	ok(await api.rename({ ...key, to: 'lee-chang' }));
	assert.deepEqual(await readdir(base), ['lee-chang']);
	assert.deepEqual(await snapshot('6 Renamed the folder', 'lee-chang'), before);
	for (const [name, source] of [
		['consent.pdf', pdf],
		['recordings/take-1.m4a', audio],
	] as const) {
		assert.deepEqual(
			await readFile(join(base, 'lee-chang', name)),
			Buffer.from(await source.arrayBuffer()),
		);
	}
	const page = 'building-tools';
	const pageRoot = join(app, 'data/pages');
	const pageDir = join(pageRoot, page);
	const bytes = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
		'base64',
	);
	const image = new File([bytes], 'diagram.png', { type: 'image/png' });
	ok(await api.pages.image({ page, image }));
	assert.deepEqual(ok(await api.pages.list({})), [page]);
	assert.deepEqual(await readdir(pageDir), ['diagram.png']);
	const body = 'See ![Diagram](./diagram.png).\n';
	ok(
		await api.pages.write({
			page,
			title: 'Building tools',
			published: false,
			body,
		}),
	);
	await writeFile(join(pageDir, 'research.md'), 'Undeclared notes.\n');
	await mkdir(join(pageDir, 'drafts'));
	await writeFile(join(pageDir, 'drafts/unused.png'), bytes);
	assert.deepEqual(ok(await api.pages.images({ page })), ['diagram.png']);
	const article = await readFile(join(pageDir, 'article.md'), 'utf8');
	assert.ok(article.includes(body));
	assert.match(article, /published: false/);
	assert.ok((await api.pages.image({ page, image })).error);
	assert.ok(
		(
			await api.pages.image({
				page,
				image: new File([bytes], 'article.md', { type: 'image/png' }),
			})
		).error,
	);
	ok(await api.pages.rename({ page, to: 'making-tools' }));
	assert.deepEqual(ok(await api.pages.list({})), ['making-tools']);
	const moved = join(pageRoot, 'making-tools');
	assert.equal(await readFile(join(moved, 'article.md'), 'utf8'), article);
	assert.deepEqual(await readFile(join(moved, 'diagram.png')), bytes);
	assert.equal(
		await readFile(join(moved, 'research.md'), 'utf8'),
		'Undeclared notes.\n',
	);
	assert.deepEqual(await readFile(join(moved, 'drafts/unused.png')), bytes);
	const result = {
		step: '7 Renamed page with neighboring assets',
		folder: 'making-tools',
		entries: (await readdir(moved, { recursive: true })).sort(),
		images: ok(await api.pages.images({ page: 'making-tools' })),
		markdown: article,
	};
	evidence.push(result);
	await writeFile(
		join(demo, 'snapshots.json'),
		JSON.stringify(evidence, null, 2),
	);
	console.log(result);
	const revised = new File(
		[await readFile(join(fixtures, 'cleaned-export.m4a'))],
		'cleaned-export.m4a',
		{ type: 'audio/mp4' },
	);
	const second = new File([audio], 'take-2.m4a', { type: 'audio/mp4' });
	const hashes = (data: Buffer) =>
		createHash('sha256').update(data).digest('hex');
	for (const variant of ['bucket', 'named'] as const) {
		const actions = api.takes[variant];
		const dir = join(
			app,
			'data',
			variant === 'bucket' ? 'buckets' : 'named',
			'lee',
		);
		const takesDir = join(dir, 'recordings');
		assert.equal(ok(await actions.exists(key)), false);
		assert.equal(await Bun.file(join(dir, 'consent.pdf')).exists(), false);
		if (variant === 'bucket') {
			const voiceMemo = new File([audio], 'Voice Memo.m4a', {
				type: 'audio/mp4',
			});
			ok(
				await api.takes.bucket.saveas({
					...key,
					name: 'take-1.m4a',
					audio: voiceMemo,
				}),
			);
			assert.equal(
				(
					await api.takes.bucket.saveas({
						...key,
						name: 'take-1.m4a',
						audio: revised,
					})
				).error?.name,
				'Refused',
			);
			ok(await api.takes.bucket.add({ ...key, audio: second }));
		} else {
			// Explicit name is independent of the incoming filename even on first save.
			ok(
				await api.takes.named.add({
					...key,
					name: 'take-1.m4a',
					audio: new File([audio], 'Voice Memo.m4a', { type: 'audio/mp4' }),
				}),
			);
			ok(
				await api.takes.named.add({
					...key,
					name: 'take-2.m4a',
					audio: second,
				}),
			);
		}
		const readTake = (name: string) => readFile(join(takesDir, name));
		const before = await readTake('take-1.m4a'),
			untouched = await readTake('take-2.m4a');
		assert.equal(ok(await actions.exists(key)), false);
		ok(await actions.sign({ ...key, pdf }));
		assert.equal(ok(await actions.exists(key)), true);
		assert.equal(
			(await actions.replace({ ...key, name: 'missing.m4a', audio: revised }))
				.error?.name,
			'Missing',
		);
		ok(await actions.replace({ ...key, name: 'take-1.m4a', audio: revised }));
		const after = await readTake('take-1.m4a');
		assert.deepEqual(before, Buffer.from(await audio.arrayBuffer()));
		assert.notDeepEqual(before, after);
		assert.deepEqual(after, Buffer.from(await revised.arrayBuffer()));
		assert.deepEqual(await readTake('take-2.m4a'), untouched);
		assert.deepEqual(
			await readFile(join(dir, 'consent.pdf')),
			Buffer.from(await pdf.arrayBuffer()),
		);
		const names = ['take-1.m4a', 'take-2.m4a'];
		assert.deepEqual(ok(await actions.list(key)), names);
		assert.deepEqual((await readdir(takesDir)).sort(), names);
		console.log(
			variant,
			'consent false → true; take-1',
			hashes(before).slice(0, 8),
			'→',
			hashes(after).slice(0, 8),
			'; take-2 unchanged; missing replacement refused',
		);
	}
	if (process.argv.includes('--vault')) {
		const { tryVault } = await import('./vault.demo');
		await tryVault(api.vault, demo, app);
	}
	console.log('Verified on disk:', demo);
} finally {
	terminal?.close();
	server.kill('SIGTERM');
	await server.exited;
	reader.releaseLock();
}
