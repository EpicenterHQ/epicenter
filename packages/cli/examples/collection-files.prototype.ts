/** PROTOTYPE: Disposable disk evidence, never a personal Epicenter.
 * bun packages/cli/examples/collection-files.prototype.ts [--keep] [--interactive]
 * [--http-base http://127.0.0.1:PORT]
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Type } from 'typebox';
import { defineCollection } from '../../app/src/collection.js';
import {
	defineDirectoryCollection,
	type OwnedFile,
	ownershipOverlaps,
} from '../../app/src/collection-files.prototype.js';
import { inRun } from '../../app/src/context.js';
import { field, type UploadedFile } from '../../app/src/field.js';
import { readMarkdown } from '../../app/src/front-matter.js';

const interactive = process.argv.includes('--interactive');
const keep = interactive || process.argv.includes('--keep');
const httpBase = process.argv[process.argv.indexOf('--http-base') + 1];
const external = process.argv.includes('--http-base');
const scratch = await realpath(
	await mkdtemp(join(tmpdir(), 'epicenter-collection-files-demo-')),
);
const home = join(scratch, 'Epicenter');
const runtime = join(scratch, 'runtime');
process.env.EPICENTER_ROOT = home;
process.env.EPICENTER_RUNTIME_DIR = runtime;
console.log(`THROWAWAY PROTOTYPE scratch: ${scratch}`);
// CLI modules are imported only after the scratch environment is installed.
const { folderOnDisk } = await import('../src/disk.js');
const { createRunHost } = await import('../src/runs.prototype.js');
const { linkAppPackage } = await import('../src/app-package.js');
const app = join(scratch, 'local', 'voice-memos');
await mkdir(app, { recursive: true });
await mkdir(join(scratch, 'inputs'));
const disk = folderOnDisk(app);
const memos = defineDirectoryCollection({
	path: 'data/memos/{slug}/memo.md',
	owns: 'directory',
	description: 'a voice memo',
	fields: {
		title: field.text(),
		audio: field.file({ accept: ['audio/*'] }),
		cover: field.file({ optional: true, accept: ['image/*'] }),
		attachments: Type.Optional(Type.Array(field.file())),
	},
});
const notes = defineDirectoryCollection({
	path: 'data/notes/{slug}/note.md',
	owns: 'directory',
	fields: {
		title: field.text(),
		attachments: Type.Optional(Type.Array(field.file())),
	},
});
const words = defineCollection({
	path: 'data/words/{word}.md',
	fields: { meaning: field.text() },
});
const returned: unknown[] = [];
let assertions = 0;
function clean(value: unknown) {
	const json = JSON.stringify(value);
	assert(!json.includes('epicenter-file:'));
	assert(!json.includes(scratch));
	assert(!json.includes(runtime));
	assertions += 3;
	return value;
}
function remember<T>(value: T): T {
	clean(value);
	returned.push(value);
	return value;
}
const digest = (bytes: Uint8Array | string) =>
	createHash('sha256').update(bytes).digest('hex');
const fileHash = async (path: string) => digest(await readFile(path));
const missing = async (path: string) => {
	await assert.rejects(lstat(path), { code: 'ENOENT' });
	assertions++;
};
async function upload(name: string, bytes: string): Promise<UploadedFile> {
	const path = join(scratch, 'inputs', randomUUID());
	await writeFile(path, bytes);
	return {
		name,
		size: Buffer.byteLength(bytes),
		type: Bun.file(name).type,
		path: () => path,
		bytes: async () => {
			throw new Error('adoption must stream path(), never bytes()');
		},
		text: async () => {
			throw new Error('adoption must not use text()');
		},
	};
}
async function tree(root: string, relative = ''): Promise<string[]> {
	const output: string[] = [];
	for (const name of (
		await readdir(join(root, relative)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return [];
				throw error;
			},
		)
	).sort()) {
		const path = relative ? `${relative}/${name}` : name;
		const at = join(root, path);
		const stat = await lstat(at);
		if (stat.isSymbolicLink()) {
			const target = await readlink(at);
			output.push(
				`${path} [symlink ${stat.size} B] -> ${target.startsWith(scratch) ? `<scratch>/${target.slice(scratch.length + 1)}` : target}`,
			);
		} else if (stat.isDirectory()) {
			output.push(`${path}/`);
			output.push(...(await tree(root, path)));
		} else
			output.push(
				`${path} [${stat.size} B sha256 ${(await fileHash(at)).slice(0, 12)}]`,
			);
	}
	return output;
}
async function snapshot(root: string, relative: string) {
	const entries: Record<string, string> = {};
	async function walk(part: string) {
		for (const name of (await readdir(join(root, part))).sort()) {
			const at = join(part, name);
			const stat = await lstat(join(root, at));
			if (stat.isDirectory()) await walk(at);
			else
				entries[at.slice(relative.length + 1)] = stat.isSymbolicLink()
					? `symlink:${await readlink(join(root, at))}`
					: await fileHash(join(root, at));
		}
	}
	await walk(relative);
	return entries;
}
async function show(
	number: number,
	title: string,
	paths: string[] = [],
	root = app,
) {
	console.log(`\n${number}. ${title}`);
	console.log(
		(await tree(join(root, 'data')))
			.map((line) => `  data/${line}`)
			.join('\n') || '  data/ (empty)',
	);
	for (const path of paths) {
		const text = await readFile(join(root, path), 'utf8').catch(
			() => undefined,
		);
		if (!text) continue;
		const parsed = readMarkdown(text);
		console.log(
			`  ${path} front matter:\n${text.slice(0, text.length - parsed.body.length).trimEnd()}`,
		);
		for (const key of ['audio', 'cover', 'attachments'])
			if (parsed.fields[key] !== undefined)
				console.log(`  ${key} -> ${JSON.stringify(parsed.fields[key])}`);
	}
}
async function assertFiles(
	root: string,
	record: string,
	expected: [OwnedFile | undefined, UploadedFile][],
) {
	for (const [file, source] of expected) {
		assert(file);
		assert.equal(
			await fileHash(join(root, dirname(record), file.file)),
			await fileHash(source.path()),
		);
		assertions++;
	}
}
async function assertLinks(
	record: { path: string; body: string },
	sources: UploadedFile[],
	names: string[],
) {
	const targets = [...record.body.matchAll(/\]\(([^)]+)\)/g)];
	assert.equal(targets.length, sources.length);
	for (const [index, match] of targets.entries()) {
		const target = match[1];
		assert(target);
		const url = new URL(target, 'file:///record/');
		assert.equal(url.hash, '');
		assert.equal(url.search, '');
		const name = decodeURIComponent(url.pathname.slice('/record/'.length));
		assert.equal(name, names[index]);
		const source = sources[index];
		assert(source);
		assert.equal(
			await fileHash(join(app, dirname(record.path), name)),
			await fileHash(source.path()),
		);
		assertions += 3;
	}
}
let host: ReturnType<typeof createRunHost> | undefined;
try {
	await inRun({ folder: disk }, async () => {
		const word = remember(
			await words.add({ word: 'hello', meaning: 'a greeting' }),
		);
		assert.equal(word.path, 'data/words/hello.md');
		assert((await lstat(join(app, word.path))).isFile());
		assert.deepEqual(await readdir(join(app, 'data/words')), ['hello.md']);
		assertions += 3;
		await show(
			1,
			'local (synthetic UploadedFile): text-only collection unchanged',
			[word.path],
		);

		const audio = await upload('walk.m4a', 'original audio bytes');
		const cover = await upload('cover.jpg', 'cover image bytes');
		const noteA = await upload('notes.pdf', 'notes bytes A');
		const noteB = await upload('notes.pdf', 'notes bytes B');
		const tricky = await upload(
			'wrong#draft).pdf',
			'fragment and parenthesis bytes',
		);
		const spaced = await upload('field notes (v2).pdf', 'field notes bytes');
		let walk = remember(
			await memos.add({
				slug: 'walk',
				title: 'Morning walk',
				audio,
				cover,
				attachments: [noteA, noteB, tricky, spaced],
			}),
		);
		assert(walk.audio && walk.cover && walk.attachments);
		walk = remember(
			await memos.edit({
				path: walk.path,
				old: '',
				new: `![cover](${walk.cover.href})\n[original audio](${walk.audio.href})\n${walk.attachments.map((file) => `[attachment](${file.href})\n`).join('')}`,
			}),
		);
		assert(walk.audio && walk.cover && walk.attachments);
		console.log(
			'  add publishes the record and its files; the body linking them is a second write (edit).',
		);
		const linkedSources = [cover, audio, noteA, noteB, tricky, spaced];
		const linkedNames = [walk.cover, walk.audio, ...walk.attachments].map(
			(file) => file.file,
		);
		await assertLinks(walk, linkedSources, linkedNames);
		const originalAudio = walk.audio;
		const originalCover = walk.cover;
		const originalAttachments = [...walk.attachments];
		assert.notEqual(walk.attachments[0]?.file, walk.attachments[1]?.file);
		await assertFiles(app, walk.path, [
			[walk.audio, audio],
			[walk.cover, cover],
			[walk.attachments[0], noteA],
			[walk.attachments[1], noteB],
			[walk.attachments[2], tricky],
			[walk.attachments[3], spaced],
		]);
		const storedWalk = readMarkdown(
			await readFile(join(app, walk.path), 'utf8'),
		);
		for (const value of [
			storedWalk.fields.audio,
			storedWalk.fields.cover,
			...(storedWalk.fields.attachments as string[]),
		]) {
			assert.equal(typeof value, 'string');
			assert(!String(value).includes('/'));
		}
		await show(
			2,
			'local (synthetic UploadedFile): add walk, distinct hashes and encoded Markdown targets',
			[walk.path],
		);

		const idea = remember(await notes.add({ slug: 'idea', title: 'An idea' }));
		assert.deepEqual(await readdir(join(app, dirname(idea.path))), ['note.md']);
		assertions++;
		console.log(
			'In a directory-owning collection every record is a directory, files or not, so adding a first file later never changes its address.',
		);
		await show(3, 'local (synthetic UploadedFile): no-attachment record', [
			idea.path,
		]);

		const beforeRoundtrip = await snapshot(app, dirname(walk.path));
		const inventory = remember(await memos.inventory({ path: walk.path }));
		const reread = remember(await memos.get({ path: walk.path }));
		assert(reread?.attachments);
		walk = remember(
			await memos.set({
				path: walk.path,
				attachments: [...reread.attachments].reverse(),
			}),
		);
		assert.deepEqual(
			walk.attachments?.map((file) => file.file),
			originalAttachments.map((file) => file.file).reverse(),
		);
		assert.deepEqual(
			remember(await memos.inventory({ path: walk.path })),
			inventory,
		);
		const afterRoundtrip = await snapshot(app, dirname(walk.path));
		delete beforeRoundtrip['memo.md'];
		delete afterRoundtrip['memo.md'];
		assert.deepEqual(afterRoundtrip, beforeRoundtrip);
		assertions += 3;
		await show(
			4,
			'local (synthetic UploadedFile): descriptors select existing bytes in reversed order',
			[walk.path],
		);

		const runAudio = await upload('run.m4a', 'run audio');
		const run = remember(
			await memos.add({ slug: 'run', title: 'A run', audio: runAudio }),
		);
		assert(run.audio);
		const unchanged = await readFile(join(app, walk.path), 'utf8');
		await assert.rejects(
			memos.set({ path: walk.path, cover: run.audio }),
			/data\/memos\/run\/memo.md/,
		);
		await assert.rejects(
			memos.set({
				path: walk.path,
				cover: { ...originalCover, folder: 'other-folder' },
			}),
			/other-folder/,
		);
		assert.equal(await readFile(join(app, walk.path), 'utf8'), unchanged);
		assertions += 3;
		await show(
			5,
			'local (synthetic UploadedFile): foreign record and foreign folder refused',
			[walk.path, run.path],
		);

		const replacement = await upload(
			'walk.m4a',
			'replacement audio, fresh bytes',
		);
		const beforeReplace = walk;
		walk = remember(await memos.set({ path: walk.path, audio: replacement }));
		assert(walk.audio);
		assert.notEqual(walk.audio.file, originalAudio.file);
		await assertFiles(app, walk.path, [
			[walk.audio, replacement],
			[originalAudio, audio],
		]);
		assert(walk.body.includes(`(${originalAudio.href})`));
		assert.deepEqual(walk.cover, beforeReplace.cover);
		assert.deepEqual(walk.attachments, beforeReplace.attachments);
		assert.equal(walk.title, beforeReplace.title);
		assertions += 5;
		await show(
			6,
			'local (synthetic UploadedFile): replacement preserves old audio and its body link',
			[walk.path],
		);

		walk = remember(await memos.set({ path: walk.path, cover: null }));
		assert.equal(walk.cover, undefined);
		assert(
			!Object.hasOwn(
				readMarkdown(await readFile(join(app, walk.path), 'utf8')).fields,
				'cover',
			),
		);
		assert.deepEqual(
			(await memos.inventory({ path: walk.path })).find(
				(entry) => entry.file === originalCover.file,
			)?.roles,
			[],
		);
		await assertFiles(app, walk.path, [[originalCover, cover]]);
		assertions += 3;
		await show(
			7,
			'local (synthetic UploadedFile): clear cover relation, preserve cover bytes',
			[walk.path],
		);

		await writeFile(
			join(app, dirname(walk.path), 'scribble.txt'),
			'unselected handwriting',
		);
		walk = remember(
			await memos.set({ path: walk.path, title: 'Morning walk, revised' }),
		);
		assert.equal(
			await readFile(join(app, dirname(walk.path), 'scribble.txt'), 'utf8'),
			'unselected handwriting',
		);
		assert.deepEqual(
			(await memos.inventory({ path: walk.path })).find(
				(entry) => entry.file === 'scribble.txt',
			)?.roles,
			[],
		);
		assertions += 2;
		await show(
			8,
			'local (synthetic UploadedFile): unknown contained file survives metadata changes',
			[walk.path],
		);

		const token = `epicenter-file:${'a'.repeat(16)}:${'b'.repeat(16)}:${'c'.repeat(16)}`;
		await assert.rejects(
			async () =>
				memos.actions().add({
					slug: 'private-ref',
					title: 'Bad',
					audio,
					attachments: [token],
				}),
			(error: unknown) => {
				assert(error instanceof Error);
				assert(!error.message.includes(token));
				assert.match(
					error.message,
					/attachments\[0\].*host did not turn into a file/,
				);
				console.log(`  refusal: ${error.message}`);
				return true;
			},
		);
		await missing(join(app, 'data/memos/private-ref'));
		await show(
			9,
			'local (synthetic UploadedFile): generated action refuses undecoded private reference',
			[walk.path],
		);

		await assert.rejects(
			memos.add({
				slug: 'failed',
				title: 'Missing upload',
				audio: { ...audio, path: () => join(scratch, 'does-not-exist') },
			}),
		);
		await missing(join(app, 'data/memos/failed'));
		assert.deepEqual(
			await readdir(join(app, 'data/memos/.epicenter.local/staging')),
			[],
		);

		const beforeRollback = await snapshot(app, dirname(walk.path));
		const rollbackUpload = await upload(
			'rollback.m4a',
			'must never remain selected',
		);
		let updates = 0;
		await assert.rejects(
			inRun(
				{
					folder: {
						...disk,
						update: async (path, revise) => {
							if (++updates === 2)
								throw new Error('simulated metadata failure');
							return disk.update(path, revise);
						},
					},
				},
				() => memos.set({ path: walk.path, audio: rollbackUpload }),
			),
			/simulated metadata failure/,
		);
		assert.deepEqual(await snapshot(app, dirname(walk.path)), beforeRollback);
		await assert.rejects(
			inRun({ folder: disk, readOnly: { action: 'prototype read-only' } }, () =>
				memos.add({ slug: 'read-only', title: 'Refused', audio }),
			),
			/read-only/,
		);
		await missing(join(app, 'data/memos/read-only'));
		assertions += 3;
		console.log(
			'  metadata failure rolled back only new files; read-only guard refused before disk writes',
		);
		await mkdir(join(app, 'data/memos/ghost'));
		await writeFile(join(app, 'data/memos/ghost/loose.txt'), 'crash bytes');
		await mkdir(
			join(app, 'data/memos/.epicenter.local/staging/crash-leftover'),
		);
		assert(
			!(await memos.list()).some(
				(record) =>
					record?.path.includes('ghost') || record?.path.includes('.epicenter'),
			),
		);
		const diagnostics = remember(await memos.check());
		console.log(`  check: ${JSON.stringify(diagnostics)}`);
		assert(
			diagnostics.some(
				(line) => line.includes('ghost/') && line.includes('lacks memo.md'),
			),
		);
		assert(diagnostics.some((line) => line.includes('staging/crash-leftover')));
		assert((await lstat(join(app, 'data/memos/ghost/loose.txt'))).isFile());
		assertions += 5;
		await show(
			10,
			'local (synthetic UploadedFile): failed adoption publishes nothing; crash leftovers diagnosed',
			[walk.path],
		);

		const beforeMove = await snapshot(app, dirname(walk.path));
		const oldPath = walk.path;
		walk = remember(
			await memos.move({ path: walk.path, to: { slug: 'morning-walk' } }),
		);
		await missing(join(app, dirname(oldPath)));
		assert.deepEqual(await snapshot(app, dirname(walk.path)), beforeMove);
		const fieldsAfterMove = readMarkdown(
			await readFile(join(app, walk.path), 'utf8'),
		).fields;
		for (const name of [
			fieldsAfterMove.audio,
			...(fieldsAfterMove.attachments as string[]),
		])
			assert(
				(await lstat(join(app, dirname(walk.path), name as string))).isFile(),
			);
		await assertLinks(walk, linkedSources, linkedNames);
		await assert.rejects(
			memos.set({ path: walk.path, audio: originalAudio }),
			/data\/memos\/walk\/memo.md/,
		);
		assertions += 3;
		await show(
			11,
			'local (synthetic UploadedFile): one directory rename preserves names, hashes, and body links',
			[walk.path],
		);

		const outside = join(scratch, 'outside.txt');
		await writeFile(outside, 'outside data, must survive');
		const outsideHash = await fileHash(outside);
		await symlink(outside, join(app, dirname(run.path), 'outside-link'));
		await writeFile(
			join(app, dirname(run.path), 'dropped.txt'),
			'unselected file to delete',
		);

		const runText = await readFile(join(app, run.path), 'utf8');
		await writeFile(
			join(app, run.path),
			runText.replace(
				'---\n',
				'---\ncover: "outside-link"\nattachments: ["missing.pdf"]\n',
			),
		);
		const broken = remember(await memos.get({ path: run.path }));
		assert.equal(broken?.cover?.notAFile, true);
		assert.equal(broken?.attachments?.[0]?.missing, true);
		assert.equal(broken?.problems?.length, 2);
		console.log(
			`  selected file diagnostics: ${JSON.stringify(broken?.problems)}`,
		);
		assertions += 3;
		const runInventory = remember(await memos.inventory({ path: run.path }));
		assert.equal(
			runInventory.find((entry) => entry.file === 'outside-link')?.kind,
			'symlink',
		);
		await assert.rejects(
			memos.set({
				path: run.path,
				cover: { ...run.audio, file: 'outside-link' },
			}),
			/not a regular file/,
		);
		const ideaHash = await fileHash(join(app, idea.path));
		const walkHashes = await snapshot(app, dirname(walk.path));
		assert.equal(await memos.delete({ path: run.path }), true);
		await missing(join(app, dirname(run.path)));
		assert.equal(await fileHash(outside), outsideHash);
		assert.equal(await fileHash(join(app, idea.path)), ideaHash);
		assert.deepEqual(await snapshot(app, dirname(walk.path)), walkHashes);
		assertions += 6;
		await show(
			12,
			'local (synthetic UploadedFile): delete whole directory, unlink symlink, preserve outside target',
			[walk.path, idea.path],
		);

		const overlaps = ownershipOverlaps({
			words,
			notes,
			memos,
			comments: { path: 'data/memos/{slug}/comments/{id}.md' },
		});
		assert(
			overlaps.some(
				(line) => line.includes('comments') && line.includes('memos'),
			),
		);
		assert.deepEqual(ownershipOverlaps({ words, notes, memos }), []);
		assertions += 2;
		console.log(`  overlaps: ${JSON.stringify(overlaps)}`);
		await show(
			13,
			'local (synthetic UploadedFile): ownership overlap diagnostics',
			[walk.path, idea.path],
		);
		console.log('\n14. Same-name app folders refuse foreign descriptors');
		const rootA = join(scratch, 'home-a/same-app');
		const rootB = join(scratch, 'home-b/same-app');
		await mkdir(rootA, { recursive: true });
		await mkdir(rootB, { recursive: true });
		const ownerA = await inRun({ folder: folderOnDisk(rootA) }, () =>
			memos.add({ slug: 'same', title: 'A', audio }),
		);
		const ownerB = await inRun({ folder: folderOnDisk(rootB) }, () =>
			memos.add({ slug: 'same', title: 'B', audio }),
		);
		assert(ownerA.audio && ownerB.audio);
		assert.equal(ownerA.path, ownerB.path);
		assert.equal(ownerA.audio.file, ownerB.audio.file);
		assert.notEqual(ownerA.audio.folder, ownerB.audio.folder);
		assert.match(ownerA.audio.folder, /^[0-9a-f]{32}$/);
		await writeFile(
			join(rootB, dirname(ownerB.path), ownerB.audio.file),
			'different bytes belonging to B',
		);
		const beforeForeign = await snapshot(rootB, dirname(ownerB.path));
		await inRun({ folder: folderOnDisk(rootB) }, async () => {
			await assert.rejects(
				memos.set({ path: ownerB.path, audio: ownerA.audio }),
				/selects only its own files/,
			);
			assert.deepEqual(
				await snapshot(rootB, dirname(ownerB.path)),
				beforeForeign,
			);
			await memos.set({ path: ownerB.path, audio: ownerB.audio });
			assert.deepEqual(
				await snapshot(rootB, dirname(ownerB.path)),
				beforeForeign,
			);
		});
		console.log(
			'  refused=true; B metadata and file hashes unchanged; B descriptor round-trips.',
		);

		console.log(
			'\n15. Canonical Markdown symlink is never read and delete unlinks it',
		);
		const linked = await notes.add({ slug: 'linked', title: 'Safe title' });
		const outsideDocument = join(scratch, 'outside.md');
		await writeFile(
			outsideDocument,
			'---\ntitle: DISTINCT OUTSIDE TITLE\n---\nDISTINCT OUTSIDE BODY\n',
		);
		const outsideDocumentHash = await fileHash(outsideDocument);
		await rm(join(app, linked.path));
		await symlink(outsideDocument, join(app, linked.path));
		const refusal = `${linked.path} is not a regular file, so it is not read`;
		for (const operation of [
			() => notes.get({ path: linked.path }),
			() => notes.edit({ path: linked.path, old: '', new: 'unsafe' }),
			() => notes.set({ path: linked.path, title: 'unsafe' }),
			() => notes.move({ path: linked.path, to: { slug: 'unsafe' } }),
			() => notes.inventory({ path: linked.path }),
		])
			await assert.rejects(operation, (error: unknown) => {
				assert(error instanceof Error);
				assert.equal(error.message, refusal);
				assert(!error.message.includes('DISTINCT OUTSIDE'));
				return true;
			});
		assert(!(await notes.list()).some((record) => record.path === linked.path));
		assert(
			(await notes.check()).includes(`${linked.path} is a symlink, not read`),
		);
		assert.equal(await fileHash(outsideDocument), outsideDocumentHash);
		await assert.rejects(
			inRun({ folder: disk, readOnly: { action: 'prototype read-only' } }, () =>
				notes.delete({ path: linked.path }),
			),
			/read-only/,
		);
		assert((await lstat(join(app, linked.path))).isSymbolicLink());
		await notes.delete({ path: linked.path });
		await missing(join(app, dirname(linked.path)));
		assert.equal(await fileHash(outsideDocument), outsideDocumentHash);
		console.log(`  get/edit/set/move/inventory: ${refusal}`);
		console.log(
			`  list omitted it; check: ${linked.path} is a symlink, not read; delete preserved outside.md.`,
		);

		console.log(
			'\n16. Collection roles enforce declared MIME type and actual streamed size',
		);
		await rm(join(app, 'data/memos/.epicenter.local/staging/crash-leftover'), {
			recursive: true,
		});
		const small = defineDirectoryCollection({
			path: 'data/small/{slug}/note.md',
			owns: 'directory',
			fields: {
				audio: field.file({ accept: ['audio/*'], maxBytes: 8 }),
				attachments: Type.Optional(
					Type.Array(field.file({ accept: ['audio/*'] })),
				),
			},
		});
		const nineteen = await upload('nineteen.m4a', '1234567890123456789');
		const tiny = await upload('tiny.m4a', '1234');
		const limited = await small.add({ slug: 'existing', audio: tiny });
		const beforeLimited = await snapshot(app, dirname(limited.path));
		const beforeMemos = await snapshot(app, dirname(walk.path));
		const cases = [
			{
				label: 'add wrong MIME',
				run: () =>
					memos.add({
						slug: 'wrong-mime',
						title: 'Refused',
						audio: { ...nineteen, type: 'application/pdf' },
					}),
				pattern: /audio: application\/pdf is not accepted \(audio\/\*\)/,
				absent: 'data/memos/wrong-mime',
			},
			{
				label: 'add declared oversized',
				run: () => small.add({ slug: 'declared-large', audio: nineteen }),
				pattern: /audio is larger than 8 bytes/,
				absent: 'data/small/declared-large',
			},
			{
				label: 'add actual oversized',
				run: () =>
					small.add({ slug: 'actual-large', audio: { ...nineteen, size: 1 } }),
				pattern: /audio is larger than 8 bytes/,
				absent: 'data/small/actual-large',
			},
			{
				label: 'set actual oversized',
				run: () =>
					small.set({ path: limited.path, audio: { ...nineteen, size: 1 } }),
				pattern: /audio is larger than 8 bytes/,
			},
			{
				label: 'list item wrong MIME',
				run: () =>
					small.add({
						slug: 'wrong-list',
						audio: tiny,
						attachments: [{ ...tiny, type: 'application/pdf' }],
					}),
				pattern: /attachments\[0\]: application\/pdf is not accepted/,
				absent: 'data/small/wrong-list',
			},
			{
				label: 'changed size within limit',
				run: () =>
					small.set({ path: limited.path, audio: { ...tiny, size: 1 } }),
				pattern: /audio changed size while it was read/,
			},
		];
		for (const negative of cases) {
			await assert.rejects(negative.run, negative.pattern);
			if (negative.absent) await missing(join(app, negative.absent));
			assert.deepEqual(
				await snapshot(app, dirname(limited.path)),
				beforeLimited,
			);
			assert.deepEqual(await snapshot(app, dirname(walk.path)), beforeMemos);
			for (const collection of ['memos', 'small'])
				assert.deepEqual(
					await readdir(
						join(app, `data/${collection}/.epicenter.local/staging`),
					),
					[],
				);
			console.log(
				`  ${negative.label}: refused; record snapshots and front matter unchanged; staging empty.`,
			);
		}
		assert(limited.audio);
		// Reselection uses actual disk size, even if the descriptor lies.
		await writeFile(
			join(app, dirname(limited.path), limited.audio.file),
			'123456789',
		);
		const oversizedOwned = await snapshot(app, dirname(limited.path));
		await assert.rejects(
			small.set({ path: limited.path, audio: { ...limited.audio, size: 1 } }),
			/audio is larger than 8 bytes/,
		);
		assert.deepEqual(
			await snapshot(app, dirname(limited.path)),
			oversizedOwned,
		);
		await writeFile(
			join(app, dirname(limited.path), limited.audio.file),
			'1234',
		);
		const roundtrip = await small.set({
			path: limited.path,
			audio: limited.audio,
		});
		assert.deepEqual(roundtrip.audio, limited.audio);
		assert.deepEqual(await snapshot(app, dirname(limited.path)), beforeLimited);
		console.log(
			'  oversized owned file refused by actual size; correct descriptor still round-trips.',
		);

		console.log(
			'\n17. A failed body edit leaves the added record and all files complete',
		);
		const partial = await memos.add({
			slug: 'body-failure',
			title: 'Complete files',
			audio,
			cover,
			attachments: [tricky, spaced],
		});
		assert(partial.audio && partial.cover && partial.attachments);
		const beforeBodyFailure = await snapshot(app, dirname(partial.path));
		await assert.rejects(
			inRun(
				{
					folder: {
						...disk,
						update: async () => {
							throw new Error('simulated body failure');
						},
					},
				},
				() =>
					memos.edit({
						path: partial.path,
						old: '',
						new: `[audio](${partial.audio?.href})`,
					}),
			),
			/simulated body failure/,
		);
		assert.deepEqual(
			await snapshot(app, dirname(partial.path)),
			beforeBodyFailure,
		);
		assert.equal((await memos.get({ path: partial.path }))?.body, '');
		await assertFiles(app, partial.path, [
			[partial.audio, audio],
			[partial.cover, cover],
			[partial.attachments[0], tricky],
			[partial.attachments[1], spaced],
		]);
		console.log(
			'  edit failed; memo.md and every file retain their hashes; body remains empty.',
		);
		console.log('  Limit: add and the body-link edit are two writes.');
	});

	await mkdir(join(home, 'apps/voice-memos'), { recursive: true });
	await writeFile(join(home, 'EPICENTER.md'), '');
	const httpApp = join(home, 'apps/voice-memos');
	await writeFile(join(httpApp, '.gitignore'), 'data/\nnode_modules/\n');
	const prototypePath = resolve(
		import.meta.dir,
		'../../app/src/collection-files.prototype.ts',
	);
	const source = `import { defineApp, defineAction, field } from '@epicenter/app';
import { Type } from ${JSON.stringify(import.meta.resolve('typebox'))};
import { defineDirectoryCollection } from ${JSON.stringify(prototypePath)};
const memos = defineDirectoryCollection({ path: 'data/memos/{slug}/memo.md', owns: 'directory', fields: {
 title: field.text(), audio: field.file({ accept: ['audio/*'] }), cover: field.file({optional:true}), attachments: Type.Optional(Type.Array(field.file())),
} });
const record = defineAction({ description: 'Adopt uploaded bytes as one directory record', input: {
 slug: field.text(), title: field.text(), audio: field.file({accept:['audio/*']}), cover: field.file({optional:true}), extraA: field.file({optional:true}), extraB: field.file({optional:true}),
}, run: ({slug, title, audio, cover, extraA, extraB}) => memos.add({slug, title, audio, cover, attachments: [extraA, extraB].filter((file): file is NonNullable<typeof file> => file !== undefined)}) });
export default defineApp({description:'Throwaway directory-owned voice memos', collections:{memos}, actions:{record, memos:memos.actions()}});
`;
	await writeFile(join(httpApp, 'epicenter.ts'), source);
	await linkAppPackage(httpApp);
	// Only initialize a disposable fixture repository. No staging or commits here;
	// the real run host owns whatever history it records during execution.
	const init = Bun.spawn(['git', '-C', httpApp, 'init', '-q'], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	assert.equal(await init.exited, 0, await new Response(init.stderr).text());
	console.log(
		`\nServe command for this scratch fixture (run the demo with --keep to retain it):\nEPICENTER_ROOT=${home} EPICENTER_RUNTIME_DIR=${runtime} bun packages/cli/src/bin.ts serve --port 0`,
	);
	if (external) {
		console.log(`Using external HTTP base: ${httpBase}`);
		const terminal = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			await terminal.question(
				'Start the printed serve command in another terminal, then press Enter: ',
			);
		} finally {
			terminal.close();
		}
	} else {
		host = createRunHost();
		await host.ready;
	}
	async function request(path: string, options: RequestInit = {}) {
		const url = `${external ? httpBase : 'http://prototype.invalid'}${path}`;
		let response: Response;
		if (external) response = await fetch(url, options);
		else {
			assert(host);
			response = await host.handle(new Request(url, options));
		}
		assert(
			response.ok,
			`${options.method ?? 'GET'} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
		);
		return response;
	}
	async function httpRecord(
		action: string,
		slug: string,
		uploads: Record<string, { name: string; type: string; bytes: string }>,
	) {
		const id = randomUUID();
		const route = `/.runs/voice-memos/${action}/${id}`;
		const input: Record<string, unknown> = { slug, title: `HTTP ${slug}` };
		for (const [key, upload] of Object.entries(uploads)) {
			const response = await request(`${route}/files/${key}`, {
				method: 'PUT',
				headers: {
					'content-type': upload.type,
					'content-length': String(Buffer.byteLength(upload.bytes)),
					'x-epicenter-file-name': encodeURIComponent(upload.name),
				},
				body: upload.bytes,
			});
			const body = (await response.json()) as { reference: string };
			assert.match(body.reference, /^epicenter-file:/);
			input[key] = body.reference;
		}
		const body = JSON.stringify(input);
		await request(route, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': String(Buffer.byteLength(body)),
			},
			body,
		});
		const events = await request(`${route}/events`);
		assert(events.body);
		const reader = events.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		let answer: Record<string, unknown> | undefined;
		try {
			while (!answer) {
				const chunk = await reader.read();
				if (chunk.done) break;
				pending += decoder.decode(chunk.value, { stream: true });
				let newline = pending.indexOf('\n');
				while (newline >= 0) {
					const event = JSON.parse(pending.slice(0, newline)) as {
						type: string;
						answer?: Record<string, unknown>;
					};
					pending = pending.slice(newline + 1);
					if (event.type === 'finished') {
						answer = event.answer;
						break;
					}
					newline = pending.indexOf('\n');
				}
			}
		} finally {
			await reader.cancel();
		}
		assert(answer, 'events must reach finished');
		assert(!answer.error, JSON.stringify(answer));
		remember(answer);
		console.log(`  ${action} returned ${JSON.stringify(answer)}`);
		const path = `data/memos/${slug}/memo.md`;
		const fields = readMarkdown(
			await readFile(join(httpApp, path), 'utf8'),
		).fields;
		for (const [key, upload] of Object.entries(uploads)) {
			const name =
				key === 'extraA'
					? (fields.attachments as string[])[0]
					: key === 'extraB'
						? (fields.attachments as string[])[1]
						: fields[key];
			assert.equal(typeof name, 'string');
			assert(!String(name).includes('/'));
			assert.equal(
				await fileHash(join(httpApp, dirname(path), name as string)),
				digest(upload.bytes),
			);
			assertions += 3;
		}
		// finished is appended just before the host removes runtime binaries; wait for
		// cleanup completion, not merely the observable terminal event.
		{
			let bins: string[] = [];
			for (let attempt = 0; attempt < 200; attempt++) {
				bins = (await allFiles(runtime)).filter((file) =>
					file.endsWith('.bin'),
				);
				if (!bins.length) break;
				await Bun.sleep(10);
			}
			assert.deepEqual(bins, []);
			assertions++;
		}
		return path;
	}
	const httpWalk = await httpRecord('record', 'http-walk', {
		audio: {
			name: 'http.m4a',
			type: 'audio/mp4',
			bytes: 'HTTP uploaded audio',
		},
		cover: {
			name: 'http.jpg',
			type: 'image/jpeg',
			bytes: 'HTTP uploaded cover',
		},
		extraA: {
			name: 'notes.pdf',
			type: 'application/pdf',
			bytes: 'HTTP attachment A',
		},
		extraB: {
			name: 'notes.pdf',
			type: 'application/pdf',
			bytes: 'HTTP attachment B',
		},
	});
	const httpGenerated = await httpRecord('memos.add', 'http-generated', {
		audio: {
			name: 'generated.m4a',
			type: 'audio/mp4',
			bytes: 'generated verb audio',
		},
		cover: {
			name: 'generated.jpg',
			type: 'image/jpeg',
			bytes: 'generated verb cover',
		},
	});
	await show(
		18,
		external
			? 'HTTP over supplied TCP base'
			: 'HTTP handler in process (no TCP socket): real run host, custom and generated actions',
		[httpWalk, httpGenerated],
		httpApp,
	);
	host?.stop();
	host = undefined;

	for (const value of returned) clean(value);
	for (const root of [app, httpApp])
		for (const file of await allFiles(join(root, 'data'))) {
			const stat = await lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			const text = await readFile(file, 'utf8');
			clean(text);
		}
	await show(
		19,
		'Final scan: returned values and every data file contain no private references or host paths',
		['data/memos/morning-walk/memo.md', 'data/notes/idea/note.md'],
	);
	console.log(
		`\nPASS: all 19 steps; ${assertions} counted assertions plus structural assertions; both real HTTP actions adopted uploads and host runtime binaries were removed.`,
	);
	if (interactive) {
		const terminal = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		console.log(
			'Commands: tree, get <slug>, inventory <slug>, delete <slug>, move <from> <to>, check, quit',
		);
		try {
			for (;;) {
				const [command, from, to] = (await terminal.question('prototype> '))
					.trim()
					.split(/\s+/);
				if (command === 'quit') break;
				try {
					await inRun({ folder: disk }, async () => {
						const path = `data/memos/${from}/memo.md`;
						switch (command) {
							case 'tree':
								console.log((await tree(join(app, 'data'))).join('\n'));
								break;
							case 'get':
								console.log(remember(await memos.get({ path })));
								break;
							case 'inventory':
								console.log(remember(await memos.inventory({ path })));
								break;
							case 'delete':
								console.log(await memos.delete({ path }));
								break;
							case 'move':
								assert(to);
								console.log(
									remember(await memos.move({ path, to: { slug: to } })),
								);
								break;
							case 'check':
								console.log(await memos.check());
								break;
							default:
								console.log('Unknown command');
						}
					});
				} catch (error) {
					console.log(
						error instanceof Error ? error.message : 'Command failed',
					);
				}
			}
		} finally {
			terminal.close();
		}
	}
} finally {
	host?.stop();
	console.log(`\nScratch locator: ${scratch}`);
	if (keep) console.log('Kept scratch (--keep or --interactive).');
	else {
		await rm(scratch, { recursive: true, force: true });
		console.log('Deleted scratch (use --keep to retain).');
	}
}
async function allFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const name of await readdir(root).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		},
	)) {
		const path = join(root, name);
		const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw error;
		});
		if (!stat) continue;
		if (stat.isDirectory() && !stat.isSymbolicLink())
			files.push(...(await allFiles(path)));
		else files.push(path);
	}
	return files;
}
