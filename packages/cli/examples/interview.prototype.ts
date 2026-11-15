/**
 * THROWAWAY disk/socket proof: bun packages/cli/examples/interview.prototype.ts
 * --keep retains only this run's scratch files; --interactive pauses between scenes.
 * No personal Epicenter, Git history, production exports, or external services.
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
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
	defineDirectory,
	markdown,
} from '../../app/src/directory.prototype.js';
import type { Answer } from '../src/output.js';

const interactive = process.argv.includes('--interactive');
const retain = interactive || process.argv.includes('--keep');
const scratch = await realpath(
	await mkdtemp(join(tmpdir(), 'epicenter-interview-PROTOTYPE-')),
);
const home = join(scratch, 'Epicenter');
const app = join(home, 'apps/interview');
const code = join(app, 'code');
const runtime = join(scratch, 'runtime');
const data = join(app, 'data/interviews');
const originalCwd = process.cwd();
const originalRoot = process.env.EPICENTER_ROOT;
const originalRuntime = process.env.EPICENTER_RUNTIME_DIR;
const modulePath = resolve(
	import.meta.dir,
	'../../app/src/directory.prototype.ts',
);
const digest = (bytes: Uint8Array | string) =>
	createHash('sha256').update(bytes).digest('hex');
// A playable quarter-second, 8 kHz mono PCM tone; no microphone or codec dependency.
const audio = Buffer.alloc(44 + 2_000 * 2);
audio.write('RIFF', 0);
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8_000, 24);
audio.writeUInt32LE(16_000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(audio.length - 44, 40);
for (let sample = 0; sample < 2_000; sample++)
	audio.writeInt16LE(
		Math.round(4_000 * Math.sin((2 * Math.PI * 440 * sample) / 8_000)),
		44 + sample * 2,
	);
const audioHash = digest(audio);
let host:
	| ReturnType<typeof import('../src/runs.prototype.js').createRunHost>
	| undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let terminal: ReturnType<typeof createInterface> | undefined;
let runs = 0;

async function inventory(
	root: string,
	relative = '',
): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	for (const name of (
		await readdir(join(root, relative)).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return [];
				throw error;
			},
		)
	).sort()) {
		const path = relative ? `${relative}/${name}` : name;
		const entry = join(root, path);
		const info = await lstat(entry);
		if (info.isSymbolicLink()) found[path] = `link:${await readlink(entry)}`;
		else if (info.isDirectory()) {
			found[`${path}/`] = 'directory';
			Object.assign(found, await inventory(root, path));
		} else found[path] = digest(await readFile(entry));
	}
	return found;
}

async function noUploadBytes(id: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		// Only inspect this run's directory: other concurrent runs can rename
		// their metadata files while completing.
		const entries = await readdir(
			join(runtime, 'runs/interview', id, 'files'),
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
		const bins = entries.filter((name) => name.endsWith('.bin'));
		if (!bins.length) return;
		await Bun.sleep(10);
	}
	assert.fail(`Upload bytes were not cleaned up for ${id}`);
}

async function scene(label: string) {
	console.log(`\n${label}`);
	const files = await inventory(data);
	for (const [path, hash] of Object.entries(files))
		console.log(`  ${path} ${hash === 'directory' ? '' : hash.slice(0, 16)}`);
	const notes = await readFile(join(data, 'lee/notes.md'), 'utf8').catch(
		() => undefined,
	);
	if (notes !== undefined) console.log(`  notes: ${JSON.stringify(notes)}`);
	if (terminal) {
		const answer = await terminal.question('Enter to continue, q to stop: ');
		if (answer.trim() === 'q') throw new Error('Interactive prototype stopped');
	}
}

async function call(
	action: string,
	input: Record<string, unknown>,
	upload?: { name: string; bytes: Uint8Array },
) {
	assert(server);
	const id = randomUUID();
	const route = `${server.url.origin}/.runs/interview/${action}/${id}`;
	if (upload) {
		const response = await fetch(`${route}/files/audio`, {
			method: 'PUT',
			headers: {
				'content-type': 'audio/wav',
				'content-length': String(upload.bytes.length),
				'x-epicenter-file-name': encodeURIComponent(upload.name),
			},
			body: new Uint8Array(upload.bytes),
			signal: AbortSignal.timeout(10_000),
		});
		assert(response.ok, await response.clone().text());
		const accepted = (await response.json()) as { reference: string };
		assert.match(accepted.reference, /^epicenter-file:/);
		input = { ...input, audio: accepted.reference };
	}
	const admitted = await fetch(route, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(10_000),
	});
	assert(admitted.ok, await admitted.clone().text());
	const events = await fetch(`${route}/events`, {
		signal: AbortSignal.timeout(10_000),
	});
	assert(events.ok && events.body);
	const reader = events.body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	let answer: Answer | undefined;
	try {
		while (!answer) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffered += decoder.decode(chunk.value, { stream: true });
			let end = buffered.indexOf('\n');
			while (end !== -1) {
				const event = JSON.parse(buffered.slice(0, end)) as {
					type: string;
					answer?: Answer;
				};
				buffered = buffered.slice(end + 1);
				if (event.type === 'finished') {
					answer = event.answer;
					break;
				}
				end = buffered.indexOf('\n');
			}
		}
	} finally {
		await reader.cancel();
	}
	assert(answer, `${action} never finished`);
	// finished precedes record/binary cleanup, so wait for the actual completed state.
	for (let attempt = 0; attempt < 200; attempt++) {
		const state = (await (await fetch(route)).json()) as { state: string };
		if (state.state === 'finished') break;
		assert(attempt < 199, 'Run record never reached finished');
		await Bun.sleep(10);
	}
	if ('returned' in answer) {
		await noUploadBytes(id);
		const json = JSON.stringify(answer);
		assert(!json.includes('epicenter-file:') && !json.includes(scratch));
	}
	runs++;
	return { id, answer };
}

async function success(
	action: string,
	input: Record<string, unknown>,
	upload?: { name: string; bytes: Uint8Array },
) {
	const result = await call(action, input, upload);
	assert('returned' in result.answer, JSON.stringify(result.answer));
	return { id: result.id, answer: result.answer };
}

async function refused(
	action: string,
	input: Record<string, unknown>,
	upload?: { name: string; bytes: Uint8Array },
) {
	const before = await inventory(data);
	const result = await call(action, input, upload);
	assert(
		'threw' in result.answer || 'error' in result.answer,
		`${action} unexpectedly succeeded: ${JSON.stringify(result.answer)}`,
	);
	assert.deepEqual(
		await inventory(data),
		before,
		`${action} changed data after refusal`,
	);
}

try {
	await mkdir(code, { recursive: true });
	await writeFile(join(home, 'EPICENTER.md'), '');
	await writeFile(
		join(code, 'package.json'),
		JSON.stringify({ name: 'interview-prototype', type: 'module' }),
	);
	await writeFile(
		join(code, 'epicenter.ts'),
		`
import {defineApp,defineAction,field,folder} from '@epicenter/app';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {defineDirectory,markdown} from ${JSON.stringify(modulePath)};
const interviews=defineDirectory({path:'data/interviews/{id}',files:{notes:markdown('notes.md')}});
const id=field.text();
const keep=defineAction({description:'Keep uploaded recording',input:{id,audio:field.file({accept:['audio/*']})},run:async({id,audio})=>{
 const kept=await interviews.at({id}).keep(audio);
 const source=await stat(audio.path()); // Still present before host cleanup.
 const saved=await stat(join(folder.path!,kept.path));
 if(source.dev===saved.dev&&source.ino===saved.ino)throw new Error('Kept bytes share the upload inode');
 return kept;
}});
const create=defineAction({description:'Create notes',input:{id,body:field.text()},run:({id,body})=>interviews.at({id}).notes.create(body)});
const edit=defineAction({description:'Correct one quote',input:{id,old:field.text(),new:field.text()},run:({id,old,new:replacement})=>interviews.at({id}).notes.edit({old,new:replacement})});
const read=defineAction({description:'Read notes',input:{id},annotations:{readOnlyHint:true},run:async({id})=>(await interviews.at({id}).notes.get())??null});
const readonly=defineAction({description:'Refuse writes from a read-only action',input:{id,body:field.text()},annotations:{readOnlyHint:true},run:({id,body})=>interviews.at({id}).notes.create(body)});
const readonlykeep=defineAction({description:'Refuse upload adoption from read-only action',input:{id,audio:field.file()},annotations:{readOnlyHint:true},run:({id,audio})=>interviews.at({id}).keep(audio)});
const badsize=defineAction({description:'Inject a copy-metadata failure',input:{id,audio:field.file()},run:({id,audio})=>interviews.at({id}).keep({...audio,size:audio.size+1})});
export default defineApp({description:'Throwaway interview proof',collections:{},actions:{keep,create,edit,read,readonly,readonlykeep,badsize}});
`,
	);
	process.env.EPICENTER_ROOT = home;
	process.env.EPICENTER_RUNTIME_DIR = runtime;
	process.chdir(scratch);
	const { linkAppPackage } = await import('../src/app-package.js');
	const { createRunHost } = await import('../src/runs.prototype.js');
	await linkAppPackage(code);
	host = createRunHost();
	await host.ready;
	server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => host!.handle(request),
	});
	if (interactive)
		terminal = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
	console.log(`THROWAWAY PROTOTYPE: ${scratch}`);
	console.log(`Real binary upload and run HTTP: ${server.url.origin}`);
	console.log(
		'Audio fixture: generated 0.25-second PCM WAV; kept without conversion.',
	);

	// Selection is a pure binding, not a read or implicit directory creation.
	const selected = defineDirectory({
		path: 'data/interviews/{id}',
		files: { notes: markdown('notes.md') },
	}).at({ id: 'lee' });
	assert.equal(selected.notes.path(), 'data/interviews/lee/notes.md');
	assert.deepEqual(await inventory(data), {});

	const kept = await success(
		'keep',
		{ id: 'lee' },
		{ name: 'Lee.wav', bytes: audio },
	);
	assert.deepEqual(kept.answer.returned, {
		path: 'data/interviews/lee/Lee.wav',
		size: audio.length,
	});
	assert.equal(digest(await readFile(join(data, 'lee/Lee.wav'))), audioHash);
	assert.equal((await stat(join(data, 'lee/Lee.wav'))).nlink, 1);
	assert.equal(
		(await stat(join(data, 'lee/Lee.wav'))).mode & 0o777,
		0o666 & ~process.umask(),
	);
	assert.equal((await success('read', { id: 'lee' })).answer.returned, null);
	await scene(
		'1. Recording kept; host upload bytes deleted; no notes required',
	);

	await mkdir(join(data, 'lee/extras'), { recursive: true });
	await writeFile(
		join(data, 'lee/handwritten.txt'),
		'Written by an outside editor.\n',
	);
	await writeFile(
		join(data, 'lee/extras/scan.bin'),
		new Uint8Array([255, 0, 41, 128, 7]),
	);
	const extras = await inventory(join(data, 'lee'));
	await success('create', { id: 'lee', body: 'Lee joined in 2018.\n' });
	await scene(
		'2. Notes created beside undeclared plain and nested binary files',
	);
	for (const [path, hash] of Object.entries(extras))
		assert.equal((await inventory(join(data, 'lee')))[path], hash);

	const frontMatter = '---\nexternal: keep me\n---\n';
	await writeFile(
		join(data, 'lee/notes.md'),
		frontMatter + 'Lee joined in 2018.\n',
	);
	const beforeEdit = await inventory(join(data, 'lee'));
	const corrected = await success('edit', {
		id: 'lee',
		old: 'in 2018',
		new: 'in 2019',
	});
	assert.deepEqual(corrected.answer.returned, {
		path: 'data/interviews/lee/notes.md',
		body: 'Lee joined in 2019.\n',
	});
	assert.equal(
		await readFile(join(data, 'lee/notes.md'), 'utf8'),
		frontMatter + 'Lee joined in 2019.\n',
	);
	assert.equal(
		(await stat(join(data, 'lee/notes.md'))).mode & 0o777,
		0o666 & ~process.umask(),
	);
	const afterEdit = await inventory(join(data, 'lee'));
	for (const [path, hash] of Object.entries(beforeEdit))
		if (path !== 'notes.md') assert.equal(afterEdit[path], hash);
	assert.equal(digest(await readFile(join(data, 'lee/Lee.wav'))), audioHash);
	await scene(
		'3. One passage corrected; external front matter and all other bytes unchanged',
	);

	await refused('create', { id: 'lee', body: 'Would overwrite notes' });
	await refused(
		'keep',
		{ id: 'lee' },
		{ name: 'Lee.wav', bytes: new Uint8Array([9]) },
	);
	await refused(
		'keep',
		{ id: 'lee' },
		{ name: 'handwritten.txt', bytes: audio },
	);
	await refused('keep', { id: 'lee' }, { name: 'NOTES.MD', bytes: audio });
	await refused(
		'keep',
		{ id: 'unsafe' },
		{ name: '../outside.wav', bytes: audio },
	);
	await refused(
		'keep',
		{ id: '../escape' },
		{ name: 'escape.wav', bytes: audio },
	);
	await refused('readonly', {
		id: 'read-only',
		body: 'Must not create a directory',
	});
	await refused(
		'readonlykeep',
		{ id: 'read-only' },
		{ name: 'blocked.wav', bytes: audio },
	);
	await refused('badsize', { id: 'lee' }, { name: 'broken.wav', bytes: audio });
	await refused('create', { id: 'bad-create', body: '---\na: [\n---\nBody' });
	await refused('edit', { id: 'missing', old: 'a', new: 'b' });
	await refused('edit', { id: 'lee', old: 'absent passage', new: 'wrong' });
	await refused('edit', {
		id: 'lee',
		old: 'keep me',
		new: 'Do not edit metadata',
	});
	await refused('create', { id: 'bad-unicode', body: '\ud800' });
	await refused('edit', { id: 'lee', old: 'in 2019', new: '\ud800' });
	await scene(
		'4. Duplicate creates, upload collisions, unsafe names, missing edits and read-only writes refused',
	);

	// Explicit creation can come first; correction still cannot resurrect moved notes.
	await success('create', { id: 'notes-first', body: 'Notes first.\n' });
	await success(
		'keep',
		{ id: 'notes-first' },
		{ name: 'later.wav', bytes: audio },
	);
	await rename(join(data, 'notes-first'), join(data, 'moved'));
	await refused('edit', {
		id: 'notes-first',
		old: 'Notes',
		new: 'Wrong location',
	});

	await success('create', { id: 'ambiguous', body: 'same same' });
	await refused('edit', { id: 'ambiguous', old: 'same', new: 'changed' });
	await success('create', { id: 'no-front-matter', body: 'Plain notes.' });
	await refused('edit', {
		id: 'no-front-matter',
		old: 'Plain notes.',
		new: '---\nexternal: 1\n---\nChanged.',
	});
	for (const [id, text] of [
		['malformed', '---\na: [\n---\nBody'],
		['unclosed', '---\na: 1\nBody'],
		['bom', '\uFEFF---\na: 1\n---\nBody'],
	]) {
		await mkdir(join(data, id!), { recursive: true });
		await writeFile(join(data, id!, 'notes.md'), text!);
		await refused('edit', { id, old: 'Body', new: 'changed' });
	}
	await scene(
		'5. Notes-first works; moved, ambiguous and malformed notes refuse correction',
	);

	const outside = join(scratch, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'notes.md'), 'Outside.');
	await symlink(outside, join(data, 'linked'), 'dir');
	await refused('create', { id: 'linked', body: 'Must stay outside' });
	await refused('keep', { id: 'linked' }, { name: 'escape.wav', bytes: audio });
	await mkdir(join(data, 'linked-note'));
	await symlink(join(outside, 'notes.md'), join(data, 'linked-note/notes.md'));
	await refused('edit', { id: 'linked-note', old: 'Outside', new: 'changed' });
	assert.equal(await readFile(join(outside, 'notes.md'), 'utf8'), 'Outside.');
	const beforeFailedCopy = await inventory(data);
	const failedCopy = await call(
		'badsize',
		{ id: 'failed-copy' },
		{ name: 'incomplete.wav', bytes: audio },
	);
	assert('threw' in failedCopy.answer);
	assert.deepEqual(await inventory(data), {
		...beforeFailedCopy,
		'failed-copy/': 'directory',
	});

	const race = await Promise.all([
		call('keep', { id: 'race' }, { name: 'same.wav', bytes: audio }),
		call(
			'keep',
			{ id: 'race' },
			{ name: 'same.wav', bytes: new Uint8Array([3, 2, 1]) },
		),
	]);
	assert.equal(race.filter(({ answer }) => 'returned' in answer).length, 1);
	assert.equal(
		race.filter(({ answer }) => 'threw' in answer || 'error' in answer).length,
		1,
	);
	assert(
		[audioHash, digest(new Uint8Array([3, 2, 1]))].includes(
			digest(await readFile(join(data, 'race/same.wav'))),
		),
	);
	for (const path of Object.keys(await inventory(data)))
		assert(!path.includes('.directory-'), 'Staging file leaked');
	for (const [path, hash] of Object.entries(extras))
		assert.equal((await inventory(join(data, 'lee')))[path], hash);
	await scene(
		'6. Static symlinks refused; failed copy leaves only an empty directory; same-name keeps have one winner',
	);

	console.log(
		`\nPASS: ${runs} real HTTP action runs; original recording retained after upload cleanup; notes corrected; undeclared files unchanged.`,
	);
	console.log(
		'Expected failed runs retain their host inputs until TTL; all are confined to this disposable runtime.',
	);
	if (retain) console.log(`Retained proof files: ${data}`);
} finally {
	terminal?.close();
	host?.stop();
	await server?.stop(true);
	process.chdir(originalCwd);
	if (originalRoot === undefined) delete process.env.EPICENTER_ROOT;
	else process.env.EPICENTER_ROOT = originalRoot;
	if (originalRuntime === undefined) delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntime;
	if (!retain) await rm(scratch, { recursive: true, force: true });
}
