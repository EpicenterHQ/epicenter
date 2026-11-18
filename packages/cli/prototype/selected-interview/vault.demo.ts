// bun packages/cli/prototype/selected-interview/demo.ts --vault
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	cp,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { connect } from '@epicenter/app/client';
import type definition from './interview.prototype';

type Client = ReturnType<typeof connect<typeof definition>>;

async function hashes(root: string) {
	const out: Record<string, string> = {};
	for (const name of (await readdir(root, { recursive: true })).sort()) {
		if ((await stat(join(root, name))).isFile())
			out[name] = createHash('sha256')
				.update(await readFile(join(root, name)))
				.digest('hex');
	}
	return out;
}

export async function tryVault(
	api: Client['vault'],
	demo: string,
	app: string,
) {
	const page = 'rewrite-beside-the-original';
	const source =
		process.env.VAULT_DEMO_PAGES ??
		join(homedir(), 'Epicenter/apps/vault/data/pages');
	const before = join(demo, 'before', 'pages');
	await mkdir(before, { recursive: true });
	await cp(join(source, page + '.md'), join(before, page + '.md'));
	await cp(join(source, page), join(before, page), { recursive: true });
	const dir = join(app, 'data/vault-pages', page);
	const short = join(dir, 'short-video');
	await mkdir(dir, { recursive: true });
	await cp(join(before, page + '.md'), join(dir, 'article.md'));
	await cp(join(before, page), short, { recursive: true });
	const direction = join(short, 'renditions/short-video/direction');
	await rename(join(direction, 'a-full.mp4'), join(short, 'final.mp4'));
	await rename(direction, join(short, 'direction'));
	// Original rendition folder is now empty.
	const { rmdir } = await import('node:fs/promises');
	await rmdir(join(short, 'renditions/short-video'));
	await rmdir(join(short, 'renditions'));
	const initial = await hashes(dir);
	const beforeRehome = await hashes(before);
	assert.deepEqual(
		Object.values(initial).sort(),
		Object.values(beforeRehome).sort(),
	);
	// Same real short baseline for both declarations, before either action edits it.
	const keyPage = join(app, 'data/keyed-pages', page);
	const shortKey = join(keyPage, 'videos/short');
	await mkdir(join(keyPage, 'videos'), { recursive: true });
	await cp(short, shortKey, { recursive: true });
	await cp(join(dir, 'article.md'), join(keyPage, 'article.md'));
	const script = join(short, 'script.md');
	const original = await readFile(script, 'utf8');
	const old = '- When I rewrite something,',
		replacement = '- When I revise a draft,';
	assert.equal(original.split(old).length, 2);
	const reviewPath = join(short, 'direction/review.md');
	const absent = await api.review({ page });
	assert.equal(absent.error, null);
	assert.equal(absent.data, null);
	// This sibling is malformed; script and final remain independently usable.
	await writeFile(reviewPath, 'No required title here.\n');
	assert.equal((await api.review({ page })).error?.name, 'Misfit');
	const edit = await api.edit({ page, old, new: replacement });
	assert.equal(edit.error, null, JSON.stringify(edit.error));
	assert.equal(
		await readFile(script, 'utf8'),
		original.replace(old, replacement),
	);
	assert.equal(
		(await api.edit({ page, old, new: replacement })).error?.name,
		'Changed',
	);
	const alternate = await readFile(join(short, 'direction/a-passage.mp4'));
	const replaced = await api.replace({
		page,
		video: new File([alternate], 'a-passage.mp4', { type: 'video/mp4' }),
	});
	assert.equal(replaced.error, null, JSON.stringify(replaced.error));
	assert.deepEqual(await readFile(join(short, 'final.mp4')), alternate);
	assert.equal(await readFile(reviewPath, 'utf8'), 'No required title here.\n');
	await writeFile(reviewPath, '---\ntitle: "Direction review"\n---\nReady.\n');
	const valid = await api.review({ page });
	assert.equal(valid.error, null);
	assert.equal(valid.data, 'Direction review');
	const { unlink } = await import('node:fs/promises');
	await unlink(reviewPath);
	const final = await hashes(dir);
	assert.deepEqual(Object.keys(final), Object.keys(initial));
	assert.deepEqual(
		Object.keys(final).filter((name) => final[name] !== initial[name]),
		['short-video/final.mp4', 'short-video/script.md'],
	);
	// The real Vault page has no long cut. Add the same test draft to both copies.
	const draft = 'Long-cut experiment. First draft.\n';
	const long = join(dir, 'long-video'),
		longKey = join(keyPage, 'videos/long');
	for (const path of [long, longKey]) {
		await mkdir(path);
		await writeFile(join(path, 'script.md'), draft);
	}
	const run = <T>(r: { data: T; error: unknown }) => {
		assert.equal(r.error, null, JSON.stringify(r.error));
		return r.data;
	};
	assert.deepEqual(run(await api.listvideos({ page })), ['long', 'short']);
	run(await api.editvideo({ page, video: 'short', old, new: replacement }));
	run(
		await api.replacevideo({
			page,
			video: 'short',
			upload: new File([alternate], 'passage.mp4', { type: 'video/mp4' }),
		}),
	);
	assert.equal(await readFile(join(longKey, 'script.md'), 'utf8'), draft);
	const longEdit = { page, old: 'First draft.', new: 'Second draft.' };
	run(await api.editlong(longEdit));
	run(await api.editvideo({ ...longEdit, video: 'long' }));
	assert.deepEqual(await hashes(shortKey), await hashes(short));
	assert.deepEqual(await hashes(longKey), await hashes(long));
	assert.equal(
		await readFile(join(longKey, 'script.md'), 'utf8'),
		'Long-cut experiment. Second draft.\n',
	);
	assert.equal(
		(await api.editvideo({ ...longEdit, video: 'missing' })).error?.name,
		'Missing',
	);
	assert.deepEqual(run(await api.listvideos({ page })), ['long', 'short']);
	// A bad review is local to its page AND its video.
	await mkdir(join(longKey, 'direction'));
	await writeFile(join(longKey, 'direction/review.md'), 'Missing title.\n');
	assert.equal(
		(await api.reviewvideo({ page, video: 'long' })).error?.name,
		'Misfit',
	);
	assert.equal(run(await api.reviewvideo({ page, video: 'short' })), null);
	assert.equal(
		run(await api.reviewvideo({ page: 'another-page', video: 'long' })),
		null,
	);
	await unlink(join(longKey, 'direction/review.md'));
	await rmdir(join(longKey, 'direction'));
	// Discover an arbitrary additional video with no script; preserve the final comparison.
	const teaser = join(keyPage, 'videos/teaser');
	await mkdir(teaser);
	await writeFile(join(teaser, 'scratch.txt'), 'Probe');
	assert.deepEqual(run(await api.listvideos({ page })), [
		'long',
		'short',
		'teaser',
	]);
	await unlink(join(teaser, 'scratch.txt'));
	await rmdir(teaser);
	assert.deepEqual(await hashes(shortKey), await hashes(short));
	assert.deepEqual(await hashes(longKey), await hashes(long));
	const report = {
		before,
		after: dir,
		keyedPage: keyPage,
		longDraft: draft,
		verifiedVideoNames: ['long', 'short'],
		old,
		replacement,
		originalFiles: beforeRehome,
		reorganized: initial,
		final,
	};
	await writeFile(
		join(demo, 'vault-proof.json'),
		JSON.stringify(report, null, 2),
	);
	console.log(
		'Vault copy verified',
		JSON.stringify({
			before,
			after: dir,
			keyedPage: keyPage,
			longDraft: draft,
			verifiedVideoNames: ['long', 'short'],
			mp4: [initial['short-video/final.mp4'], final['short-video/final.mp4']],
		}),
	);
}
