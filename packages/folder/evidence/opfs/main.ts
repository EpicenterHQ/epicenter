/**
 * EVIDENCE: browser-folder acceptance checks in a real browser.
 *
 * Every check opens folders through the production browser opener, in this
 * origin's real OPFS, Web Locks, and BroadcastChannel, under fresh disposable
 * `development` scope IDs. A same-origin iframe (`peer.ts`) is a second
 * browsing context on the same folder. The run removes its OPFS directories
 * when it finishes.
 *
 * Every outcome is visible on the page: one list item per check whose
 * `.status` reads PASS, FAIL, or NOTE with its detail, `#state` with
 * `data-state="done"` and the totals, and a layout table that pairs each
 * logical path with the stored OPFS file it is. "Reload persistence check"
 * (`?reload=1`) writes a folder and reads it back after a page reload at
 * `?reload=2`; that page then drops the query, so "Run again" or a plain
 * reload starts a full run. `?reload=2` reached any other way says the check
 * was not run.
 *
 * The recovery checks build a pending incoming update the way a tab that
 * closed mid-publication leaves one: the record, the branch at the admitted
 * commit, and files partly written; or an empty record, as a tab leaves one
 * that closed before its admission finished. They write those raw entries
 * with the browser's own OPFS API, then use only `git.recoverIncoming()` and
 * the folder's public methods. No remote is reached.
 *
 * The identity check writes a stray file into an unmarked directory, and a
 * ready marker naming another address into another, with the browser's own
 * OPFS API, and opens each. The row check reads malformed and
 * schema-invalid text as `InvalidRow` and repairs it with a guarded
 * `replace`. The stream probes use the browser's own OPFS API on a directory of their
 * own: the lock an open write stream holds, and what a stream for a removed
 * file does with and without the recheck the replacement makes.
 *
 * Not covered here: quota exhaustion, eviction, a real crash during a stream
 * close, and a removal that lands between the replacement's handle and its
 * stream through the folder itself. The Bun suites cover interruption at
 * each step, and that removal, over an in-memory model of Chrome's OPFS.
 */
import type { Result } from 'wellcrafted/result';
import {
	DECLARATION_PATH,
	defineFolder,
	defineTable,
	type Folder,
	field,
	formatDeclaration,
	hashBytes,
	openFolder,
} from '../../src/browser.js';
import type { PeerReply, PeerRequest } from './peer.js';

type Status = 'pass' | 'fail' | 'note';

const definition = defineFolder({
	kv: {},
	tables: { rows: defineTable({ fields: { title: field.string() } }) },
});
const scope = { channel: 'development' as const };
const author = { name: 'Evidence', email: 'evidence@example.test' };
/** Never reached: merges and pulls are refused before any transfer here. */
const remote = { url: 'http://127.0.0.1:9/unreachable.git', branch: 'main' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const used = new Set<string>();
const opened: Folder<typeof definition>[] = [];
let runId = '';
let totals = { pass: 0, fail: 0 };

const element = (id: string) => document.getElementById(id)!;

function record(name: string, status: Status, detail: string) {
	if (status !== 'note') totals[status]++;
	const item = document.createElement('li');
	item.className = status;
	item.dataset.check = name;
	const label = document.createElement('span');
	label.className = 'status';
	label.textContent = status.toUpperCase();
	item.append(label, ` ${name}: ${detail}`);
	element('checks').append(item);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function check(name: string, run: () => Promise<string>) {
	try {
		record(name, 'pass', await run());
	} catch (cause) {
		record(
			name,
			'fail',
			cause instanceof Error ? cause.message : String(cause),
		);
	}
}

function ok<T>(result: Result<T, { name: string; message: string }>): T {
	const { data: value, error } = result;
	if (error !== null) throw new Error(`${error.name}: ${error.message}`);
	return value;
}

async function open(
	id: string,
	options: {
		remote?: boolean;
		definition?: typeof definition;
	} = {},
) {
	used.add(id);
	const { data: folder, error: openError } = await openFolder({
		id,
		definition: options.definition ?? definition,
		browser: {
			scope,
			author,
			remote: options.remote ? remote : undefined,
		},
	});
	if (openError !== null) throw new Error(`open refused: ${openError.message}`);
	opened.push(folder);
	return folder;
}

async function closeAll() {
	for (const folder of opened.splice(0)) await folder.close();
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

function randomBytes(size: number) {
	const bytes = new Uint8Array(size);
	for (let offset = 0; offset < size; offset += 65536)
		crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
	return bytes;
}

/** The folder's directory, read with the browser's own OPFS API. */
async function rawDirectory(id: string, create = false) {
	const origin = await navigator.storage.getDirectory();
	const channel = await origin.getDirectoryHandle('Epicenter Dev', { create });
	const local = await channel.getDirectoryHandle('local', { create });
	return local.getDirectoryHandle(id, { create });
}

async function rawParent(id: string, path: string, create = false) {
	let directory = await rawDirectory(id, create);
	const parts = path.split('/');
	for (const part of parts.slice(0, -1))
		directory = await directory.getDirectoryHandle(part, { create });
	return { directory, name: parts.at(-1)! };
}

async function rawRead(id: string, path: string) {
	const { directory, name } = await rawParent(id, path);
	const file = await (await directory.getFileHandle(name)).getFile();
	return new Uint8Array(await file.arrayBuffer());
}

/** Write raw bytes as an uncooperative program would: no lock, no check. */
async function rawWrite(id: string, path: string, bytes: Uint8Array) {
	const { directory, name } = await rawParent(id, path, true);
	const handle = await directory.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(bytes as Uint8Array<ArrayBuffer>);
	await writable.close();
}

async function rawRemove(id: string, path: string) {
	const { directory, name } = await rawParent(id, path);
	await directory.removeEntry(name);
}

async function rawExists(id: string, path: string) {
	try {
		await rawRead(id, path);
		return true;
	} catch {
		return false;
	}
}

type Entry = { name: string; kind: 'file' | 'directory' };
async function rawEntries(directory: FileSystemDirectoryHandle) {
	const entries: Entry[] = [];
	for await (const handle of (
		directory as unknown as {
			values(): AsyncIterable<{ name: string; kind: 'file' | 'directory' }>;
		}
	).values())
		entries.push({ name: handle.name, kind: handle.kind });
	return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function countFiles(
	directory: FileSystemDirectoryHandle,
): Promise<number> {
	let count = 0;
	for (const entry of await rawEntries(directory))
		count +=
			entry.kind === 'file'
				? 1
				: await countFiles(await directory.getDirectoryHandle(entry.name));
	return count;
}

/** A second browsing context on this origin. */
async function peer() {
	const frame = document.createElement('iframe');
	frame.src = './peer.html';
	const ready = new Promise<void>((resolve) => {
		const listen = (event: MessageEvent) => {
			if (event.source === frame.contentWindow && event.data?.ready) {
				removeEventListener('message', listen);
				resolve();
			}
		};
		addEventListener('message', listen);
	});
	document.body.append(frame);
	await ready;
	let next = 0;
	return {
		ask(request: PeerRequest): Promise<PeerReply> {
			const id = ++next;
			return new Promise((resolve) => {
				const listen = (event: MessageEvent) => {
					if (event.source !== frame.contentWindow || event.data?.id !== id)
						return;
					removeEventListener('message', listen);
					resolve(event.data.reply as PeerReply);
				};
				addEventListener('message', listen);
				frame.contentWindow?.postMessage({ id, request }, location.origin);
			});
		},
		remove: () => frame.remove(),
	};
}

async function cleanup() {
	await closeAll();
	const origin = await navigator.storage.getDirectory();
	for (const id of used) {
		try {
			const local = await (
				await origin.getDirectoryHandle('Epicenter Dev')
			).getDirectoryHandle('local');
			await local.removeEntry(id, { recursive: true });
		} catch {
			// Already gone.
		}
	}
	used.clear();
}

/** Pair every logical path with its stored file, in the layout table. */
async function showLayout(folder: Folder<typeof definition>, id: string) {
	const table = element('layout');
	const header = document.createElement('tr');
	for (const heading of [
		'logical path',
		'stored OPFS file',
		'bytes',
		'SHA-256 read through the folder',
		'SHA-256 of the stored file',
		'same',
	]) {
		const cell = document.createElement('th');
		cell.textContent = heading;
		header.append(cell);
	}
	table.replaceChildren(header);
	let mismatches = 0;
	const listing = ok(await folder.files.list());
	for (const { path, size } of listing.files) {
		const viaFolder = ok(await folder.files.read(path)).sha256;
		const stored = await hashBytes(await rawRead(id, path));
		if (viaFolder !== stored) mismatches++;
		const row = document.createElement('tr');
		row.dataset.path = path;
		for (const text of [
			path,
			`Epicenter Dev/local/${id}/${path}`,
			String(size),
			viaFolder.slice(0, 16),
			stored.slice(0, 16),
			viaFolder === stored ? 'yes' : 'NO',
		]) {
			const cell = document.createElement('td');
			cell.textContent = text;
			row.append(cell);
		}
		table.append(row);
	}
	const git = await countFiles(
		await (await rawDirectory(id)).getDirectoryHandle('.git'),
	);
	element('layout-caption').textContent =
		`${listing.files.length} files and ${listing.directories.length} directories ` +
		`(${listing.directories.join(', ')}). Private Git state: ` +
		`Epicenter Dev/local/${id}/.git holds ${git} files and is never listed. ` +
		`${mismatches} mismatches.`;
	return mismatches;
}

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

/** Publication uses real OPFS; history-enabled acquisition is a separate case. */
async function publication(id: string) {
	await check(
		'opening publishes the prepared definition before returning',
		async () => {
			await open(id);
			const expected = formatDeclaration(definition);
			const stored = decoder.decode(await rawRead(id, DECLARATION_PATH));
			assert(stored === expected, `stored ${stored}`);
			return `epicenter.json: ${stored}`;
		},
	);
	await check(
		'reopening replaces a hand-written description and changed declarations leave row bytes intact',
		async () => {
			const folder = await open(id);
			ok(
				await folder.files.create(
					'rows/kept.md',
					'---\ntitle: Kept\n---\nSaved body\n',
				),
			);
			const before = await rawRead(id, 'rows/kept.md');
			ok(
				await folder.files.overwrite(
					DECLARATION_PATH,
					'hand-written malformed description',
				),
			);
			await folder.close();
			const reopened = await open(id);
			assert(
				decoder.decode(await rawRead(id, DECLARATION_PATH)) ===
					formatDeclaration(definition),
				'hand-written description stayed',
			);
			await reopened.close();
			const changed = defineFolder({
				...definition,
				title: 'Changed publication',
			});
			await open(id, { definition: changed });
			assert(
				decoder.decode(await rawRead(id, DECLARATION_PATH)) ===
					formatDeclaration(changed),
				'changed declaration was not published',
			);
			assert(
				sameBytes(await rawRead(id, 'rows/kept.md'), before),
				'row bytes changed',
			);
			return 'hand-written description replaced; changed title published; saved Markdown unchanged';
		},
	);
	await check(
		'history-enabled publication settles and identical reopening adds no commit',
		async () => {
			const historyId = `${id}-history`;
			const settle = async (folder: Folder<typeof definition>) => {
				for (let attempt = 0; attempt < 1000; attempt++) {
					if (!folder.git.snapshot.activity.commit.active) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error('automatic history did not settle');
			};
			const first = await open(historyId);
			await settle(first);
			const commits = ok(await first.git.log(10));
			assert(commits.length === 1, `initial commits ${commits.length}`);
			await first.close();
			const second = await open(historyId);
			await settle(second);
			const after = ok(await second.git.log(10));
			assert(
				JSON.stringify(after) === JSON.stringify(commits),
				'identical reopening added history',
			);
			assert(
				ok(await second.git.status()).changes.length === 0,
				'settled tree is dirty',
			);
			return `one settled commit ${commits[0]?.oid}; unchanged reopening keeps it`;
		},
	);
}

async function filesAndLayout(id: string) {
	const large = randomBytes(4 * 1024 * 1024);
	await check('one path is one stored file; .git is private', async () => {
		const folder = await open(id);
		assert(
			folder.location.kind === 'opfs' &&
				folder.location.directory === `Epicenter Dev/local/${id}`,
			`location ${JSON.stringify(folder.location)}`,
		);
		ok(await folder.files.create('notes/a.md', '# A\n'));
		const raw = decoder.decode(await rawRead(id, 'notes/a.md'));
		assert(raw === '# A\n', `stored file holds ${JSON.stringify(raw)}`);
		const names = (await rawEntries(await rawDirectory(id))).map(
			(entry) => entry.name,
		);
		assert(names.includes('.git'), `stored names ${names}`);
		const listing = ok(await folder.files.list());
		assert(
			!listing.directories.some((path) => path.startsWith('.git')) &&
				!listing.files.some((file) => file.path.startsWith('.git')),
			'the listing shows .git',
		);
		return `stored names at the folder root: ${names.join(', ')}`;
	});

	await check(
		'exact bytes and empty directories survive reopening',
		async () => {
			let folder = await open(id);
			ok(await folder.files.create('bytes.bin', allBytes));
			ok(await folder.files.create('empty.txt', ''));
			ok(await folder.files.create('large.bin', large));
			ok(await folder.files.create('ünïcode/ノート.md', 'text'));
			ok(await folder.files.mkdir('empty/nested'));
			await closeAll();
			folder = await open(id);
			assert(
				sameBytes(ok(await folder.files.read('bytes.bin')).bytes, allBytes),
				'bytes.bin',
			);
			assert(
				ok(await folder.files.read('empty.txt')).bytes.byteLength === 0,
				'empty.txt',
			);
			assert(
				sameBytes(ok(await folder.files.read('large.bin')).bytes, large),
				'large.bin',
			);
			assert(
				decoder.decode(
					ok(await folder.files.read('ünïcode/ノート.md')).bytes,
				) === 'text',
				'unicode path',
			);
			const listing = ok(await folder.files.list());
			assert(listing.directories.includes('empty/nested'), 'empty/nested');
			return `${listing.files.length} files, ${listing.directories.length} directories`;
		},
	);

	await check(
		'names differing by case or Unicode form stay distinct',
		async () => {
			const folder = await open(id);
			const names = ['Case.md', 'case.md', 'é.md', 'é.md', 'a b%20c.md'];
			for (const name of names)
				ok(await folder.files.create(`names/${name}`, name));
			for (const name of names) {
				const read = decoder.decode(
					ok(await folder.files.read(`names/${name}`)).bytes,
				);
				assert(
					read === name,
					`${JSON.stringify(name)} reads ${JSON.stringify(read)}`,
				);
			}
			const stored = (
				await rawEntries(
					await (await rawDirectory(id)).getDirectoryHandle('names'),
				)
			).length;
			assert(
				stored === names.length,
				`${stored} stored files for ${names.length} names`,
			);
			return `${names.length} names, ${stored} stored files`;
		},
	);

	await check(
		'an opened Blob keeps its bytes after the path is replaced',
		async () => {
			const folder = await open(id);
			const saved = ok(await folder.files.create('take.bin', large));
			const blob = ok(await folder.files.open('take.bin'));
			const { directory, name } = await rawParent(id, 'take.bin');
			const snapshot = await (await directory.getFileHandle(name)).getFile();
			ok(await folder.files.replace(saved, 'replaced'));
			assert(
				sameBytes(new Uint8Array(await blob.arrayBuffer()), large),
				'the Blob changed',
			);
			let rawOutcome: string;
			try {
				const bytes = new Uint8Array(await snapshot.arrayBuffer());
				rawOutcome = sameBytes(bytes, large)
					? 'still read the old bytes'
					: `read ${bytes.byteLength} other bytes`;
			} catch (cause) {
				rawOutcome = `refused: ${(cause as Error).name}`;
			}
			record(
				'a raw getFile() snapshot taken before replacement',
				'note',
				rawOutcome,
			);
			return 'the Blob kept 4 MiB';
		},
	);

	await check(
		'the layout table pairs every logical path with its stored file',
		async () => {
			const folder = await open(id);
			const mismatches = await showLayout(folder, id);
			assert(
				mismatches === 0,
				`${mismatches} paths differ from their stored file`,
			);
			return 'every row reads the same SHA-256 both ways';
		},
	);
}

async function twoContexts(id: string) {
	const other = await peer();
	try {
		const joined = await other.ask({ kind: 'open', id });
		assert(joined.ok, `peer open: ${joined.error}`);

		await check(
			'across contexts, exactly one of two creates wins',
			async () => {
				const folder = await open(id);
				for (let round = 0; round < 10; round++) {
					const path = `race/create-${round}.md`;
					const [{ error: mineError }, theirs] = await Promise.all([
						folder.files.create(path, 'main'),
						other.ask({ kind: 'create', path, content: 'peer' }),
					]);
					const winners = Number(mineError === null) + Number(theirs.ok);
					const loser = mineError?.name ?? theirs.error;
					assert(
						winners === 1 && loser === 'Exists',
						`round ${round}: ${winners} winners, ${loser}`,
					);
				}
				return '10 rounds';
			},
		);

		await check(
			'across contexts, exactly one of two replacements wins',
			async () => {
				const folder = await open(id);
				for (let round = 0; round < 10; round++) {
					const path = `race/replace-${round}.md`;
					const base = ok(await folder.files.create(path, 'base'));
					const [{ error: mineError }, theirs] = await Promise.all([
						folder.files.replace(base, 'main'),
						other.ask({
							kind: 'replace',
							path,
							sha256: base.sha256,
							content: 'peer',
						}),
					]);
					const winners = Number(mineError === null) + Number(theirs.ok);
					const loser = mineError?.name ?? theirs.error;
					assert(
						winners === 1 && loser === 'Conflict',
						`round ${round}: ${winners} winners, ${loser}`,
					);
				}
				return '10 rounds';
			},
		);

		await check('a save is hinted to the other context', async () => {
			const folder = await open(id);
			ok(await folder.files.create('hinted.md', 'x'));
			for (let wait = 0; wait < 50; wait++) {
				const { hints = [] } = await other.ask({ kind: 'hints' });
				if (hints.includes('hinted.md')) return `after about ${wait * 20} ms`;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error('no hint arrived');
		});

		await check(
			'a reader in another context sees whole old or new bytes',
			async () => {
				const folder = await open(id);
				const first = randomBytes(8 * 1024 * 1024);
				const second = randomBytes(8 * 1024 * 1024);
				const hashes = new Set([
					await hashBytes(first),
					await hashBytes(second),
				]);
				ok(await folder.files.create('big.bin', first));
				const reading = other.ask({
					kind: 'readFor',
					path: 'big.bin',
					ms: 2000,
				});
				for (let round = 0; round < 6; round++)
					ok(
						await folder.files.overwrite(
							'big.bin',
							round % 2 === 0 ? second : first,
						),
					);
				const reply = await reading;
				assert(reply.ok, `the peer reader failed: ${reply.error}`);
				const { seen = [], failures = 0 } = reply;
				assert(
					seen.length > 0,
					`the peer reader completed no successful read: ${failures} failed reads`,
				);
				assert(
					seen.every((hash) => hashes.has(hash)),
					`a read saw other bytes: ${seen}`,
				);
				const names = (await rawEntries(await rawDirectory(id))).map(
					(entry) => entry.name,
				);
				return `${seen.length} distinct states seen, ${failures} failed reads; stored names at the root: ${names.join(', ')}`;
			},
		);
	} finally {
		await other.ask({ kind: 'close' });
		other.remove();
	}
}

async function history(id: string) {
	await check(
		'history: commit, clean status, and the same log after reopening',
		async () => {
			let folder = await open(id);
			const commit = await folder.git.commit();
			assert(commit.status === 'committed', `commit ${commit.status}`);
			assert(
				ok(await folder.git.status()).changes.length === 0,
				'status is not clean',
			);
			await closeAll();
			folder = await open(id);
			const [head] = ok(await folder.git.log(1));
			assert(head?.oid === commit.oid, 'the log changed');
			assert(ok(await folder.git.paths()).length === 0, 'paths are not clean');
			return commit.oid;
		},
	);
}

/**
 * A folder whose last commit's publication stopped partway, as a closed tab
 * leaves it: the record names the commit before and the commit published,
 * the branch is still at the commit before, the index already matches the
 * published commit, `a.md` already holds its new bytes, and `c.md`, new in
 * the published commit, was never written.
 */
async function interrupted(id: string) {
	const folder = await open(id);
	ok(await folder.files.create('a.md', '1'));
	ok(await folder.files.create('b.md', '1'));
	const before = await folder.git.commit();
	assert(before.status === 'committed', `first commit ${before.status}`);
	ok(await folder.files.overwrite('a.md', '2'));
	ok(await folder.files.create('c.md', 'new'));
	const after = await folder.git.commit();
	assert(after.status === 'committed', `second commit ${after.status}`);
	await closeAll();
	const pending = {
		operationId: `evidence-${crypto.randomUUID()}`,
		branch: 'main',
		expectedHead: before.oid,
		nextHead: after.oid,
	};
	await rawWrite(id, '.git/refs/heads/main', encoder.encode(`${before.oid}\n`));
	await rawRemove(id, 'c.md');
	await rawWrite(
		id,
		'.git/epicenter-incoming.json',
		encoder.encode(JSON.stringify(pending)),
	);
	return pending;
}

async function waitForPending(folder: Folder<typeof definition>) {
	for (let wait = 0; wait < 100; wait++) {
		if (folder.git.snapshot.pendingIncoming !== undefined)
			return folder.git.snapshot.pendingIncoming;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

async function recovery(id: string) {
	await check(
		'a pending update is shown, resumes nothing, and lets saves land',
		async () => {
			const pending = await interrupted(`${id}-pending`);
			const folder = await open(`${id}-pending`, { remote: true });
			const shown = await waitForPending(folder);
			assert(
				shown?.state === 'recorded' &&
					shown.operationId === pending.operationId,
				`snapshot shows ${JSON.stringify(shown)}`,
			);
			const commit = await folder.git.commit();
			assert(commit.status === 'blocked', `commit ${commit.status}`);
			const { error: mergeError } = await folder.git.mergeIncoming();
			assert(
				mergeError?.name === 'IncomingPending',
				`merge ${mergeError?.name ?? 'ok'}`,
			);
			ok(await folder.files.create('notes.md', 'saved while pending'));
			assert(
				!(await rawExists(`${id}-pending`, 'c.md')),
				'c.md was written without recovery',
			);
			assert(
				await rawExists(`${id}-pending`, '.git/epicenter-incoming.json'),
				'the record went away',
			);
			return `operation ${pending.operationId.slice(0, 18)}…; commit blocked; merge IncomingPending; notes.md saved`;
		},
	);

	await check(
		'recoverIncoming() completes it from the files it finds',
		async () => {
			const folder = await open(`${id}-pending`, { remote: true });
			await waitForPending(folder);
			const recovered = ok(await folder.git.recoverIncoming());
			assert(recovered.status === 'completed', `recovery ${recovered.status}`);
			const changed =
				recovered.status === 'completed'
					? recovered.changedPaths.join(', ')
					: '';
			assert(changed === 'a.md, c.md', `changed ${changed}`);
			assert(
				decoder.decode(await rawRead(`${id}-pending`, 'c.md')) === 'new',
				'c.md',
			);
			assert(
				!(await rawExists(`${id}-pending`, '.git/epicenter-incoming.json')),
				'the record remains',
			);
			assert(
				folder.git.snapshot.pendingIncoming === undefined,
				'the snapshot still shows it',
			);
			const changes = ok(await folder.git.status()).changes.map(
				(change) => change.path,
			);
			assert(changes.join() === 'notes.md', `status ${changes}`);
			await showLayout(folder, `${id}-pending`);
			return `completed ${changed}; status shows only notes.md`;
		},
	);

	await check(
		'a third value is refused and named; once restored, recovery completes',
		async () => {
			await interrupted(`${id}-third`);
			const folder = await open(`${id}-third`);
			await waitForPending(folder);
			const current = ok(await folder.files.read('a.md'));
			const third = ok(await folder.files.replace(current, 'third'));
			const { error: refusal } = await folder.git.recoverIncoming();
			assert(
				refusal?.name === 'RecoveryRefused' && refusal.paths.join() === 'a.md',
				`recovery ${refusal?.name ?? 'ok'}`,
			);
			assert(
				!(await rawExists(`${id}-third`, 'c.md')),
				'a refused recovery wrote c.md',
			);
			ok(await folder.files.replace(third, '1'));
			const recovered = ok(await folder.git.recoverIncoming());
			assert(recovered.status === 'completed', `recovery ${recovered.status}`);
			return `refused naming a.md (${refusal.message}); completed after a.md returned to its before bytes`;
		},
	);

	await check(
		'a branch already at the published commit is cleared without writing files',
		async () => {
			const pending = await interrupted(`${id}-cleared`);
			await rawWrite(
				`${id}-cleared`,
				'.git/refs/heads/main',
				encoder.encode(`${pending.nextHead}\n`),
			);
			const folder = await open(`${id}-cleared`);
			await waitForPending(folder);
			const cleared = ok(await folder.git.recoverIncoming());
			assert(cleared.status === 'cleared', `recovery ${cleared.status}`);
			assert(
				!(await rawExists(`${id}-cleared`, 'c.md')),
				'clearing wrote c.md',
			);
			const changes = ok(await folder.git.status()).changes;
			assert(
				changes.length === 1 &&
					changes[0]?.path === 'c.md' &&
					changes[0].kind === 'delete',
				`status ${JSON.stringify(changes)}`,
			);
			return 'cleared; status reports c.md deleted instead of assuming clean';
		},
	);

	await check(
		'an empty record is an admission that never finished: Git waits until recoverIncoming() removes it',
		async () => {
			const unadmitted = `${id}-unadmitted`;
			let folder = await open(unadmitted);
			ok(await folder.files.create('a.md', '1'));
			const first = await folder.git.commit();
			assert(first.status === 'committed', `first commit ${first.status}`);
			await closeAll();
			await rawWrite(
				unadmitted,
				'.git/epicenter-incoming.json',
				new Uint8Array(),
			);
			folder = await open(unadmitted);
			const shown = await waitForPending(folder);
			assert(
				shown?.state === 'unadmitted',
				`snapshot shows ${JSON.stringify(shown)}`,
			);
			ok(await folder.files.create('notes.md', 'saved while pending'));
			const blocked = await folder.git.commit();
			assert(blocked.status === 'blocked', `commit ${blocked.status}`);
			const recovered = ok(await folder.git.recoverIncoming());
			assert(
				recovered.status === 'admissionCleared',
				`recovery ${recovered.status}`,
			);
			assert(
				!(await rawExists(unadmitted, '.git/epicenter-incoming.json')),
				'the empty record remains',
			);
			assert(
				folder.git.snapshot.pendingIncoming === undefined,
				'the snapshot still shows it',
			);
			const changes = ok(await folder.git.status()).changes.map(
				(change) => change.path,
			);
			assert(changes.join() === 'notes.md', `status ${changes}`);
			const committed = await folder.git.commit();
			assert(committed.status === 'committed', `commit ${committed.status}`);
			return `pending state "${shown.state}"; commit blocked; recovery "${recovered.status}"; status then shows notes.md and a commit lands`;
		},
	);
}

async function identity(id: string) {
	/** Open `folderId`, expecting a refusal; a folder that opens anyway is closed with the run. */
	async function refusal(folderId: string) {
		used.add(folderId);
		const { data: folder, error } = await openFolder({
			id: folderId,
			definition,
			browser: { scope, author },
		});
		if (error === null) opened.push(folder);
		return error;
	}

	await check(
		"a directory that is not this folder's is refused and left as it is",
		async () => {
			const unmarked = `${id}-unmarked`;
			await rawWrite(unmarked, 'found.txt', encoder.encode('found'));
			const stray = await refusal(unmarked);
			assert(
				stray?.name === 'Unavailable',
				`unmarked: ${stray?.name ?? 'opened'}`,
			);
			assert(
				decoder.decode(await rawRead(unmarked, 'found.txt')) === 'found',
				'found.txt changed',
			);
			assert(
				!(await rawExists(unmarked, '.git/epicenter-folder.json')),
				'a marker was written beside found.txt',
			);

			const marked = `${id}-marked`;
			const marker = encoder.encode(
				JSON.stringify({
					address: JSON.stringify(['release', 'local', null, marked]),
				}),
			);
			await rawWrite(marked, '.git/epicenter-folder.json', marker);
			const foreign = await refusal(marked);
			assert(
				foreign?.name === 'Unavailable',
				`marked: ${foreign?.name ?? 'opened'}`,
			);
			assert(
				sameBytes(await rawRead(marked, '.git/epicenter-folder.json'), marker),
				'the other address marker was rewritten',
			);
			return `${stray.message}; ${foreign.message}`;
		},
	);
}

async function rowRepair(id: string) {
	await check(
		'malformed and schema-invalid text reads as InvalidRow with its exact text, and a guarded replace repairs it',
		async () => {
			const folder = await open(id);
			const brokenText = '---\ntitle: [\n---\n';
			const untitledText = '---\nowner: sam\n---\n';
			ok(await folder.files.create('rows/broken.md', brokenText));
			ok(await folder.files.create('rows/untitled.md', untitledText));
			const { error: broken } = await folder.tables.rows.get('broken');
			const { error: untitled } = await folder.tables.rows.get('untitled');
			assert(
				broken?.name === 'InvalidRow' && broken.text === brokenText,
				`broken read as ${JSON.stringify(broken)}`,
			);
			assert(
				untitled?.name === 'InvalidRow' &&
					untitled.text === untitledText &&
					untitled.issues[0].field === 'title',
				`untitled read as ${JSON.stringify(untitled)}`,
			);
			const repaired = '---\n"title": "Repaired"\n---\n';
			ok(
				await folder.tables.rows.replace(broken, {
					fields: { title: 'Repaired' },
					body: '',
				}),
			);
			const stored = decoder.decode(await rawRead(id, 'rows/broken.md'));
			assert(stored === repaired, `stored ${JSON.stringify(stored)}`);
			const reread = ok(await folder.tables.rows.get('broken'));
			assert(
				reread?.row.fields.title === 'Repaired',
				`the repair read back as ${JSON.stringify(reread)}`,
			);
			return `read ${broken.issues.length} and ${untitled.issues.length} issues; the replacement saved ${JSON.stringify(stored)}`;
		},
	);
}

/** The name of what a promise rejected with, or `done`. */
const outcome = (promise: Promise<unknown>) =>
	promise.then(
		() => 'done',
		(cause) => (cause instanceof Error ? cause.name : String(cause)),
	);

async function writeHandle(handle: FileSystemFileHandle, text: string) {
	const writable = await handle.createWritable({ keepExistingData: false });
	await writable.write(encoder.encode(text));
	await writable.close();
}

/**
 * What the OPFS replacement relies on, probed with the browser's own API in
 * this run's directory: a stream's lock, and a stream for a removed file.
 * The store's tests run a model of these behaviors; these probes are the
 * browser itself.
 */
async function streams(id: string) {
	used.add(id);
	await check(
		'an open write stream refuses removing its file and, recursively, a directory above it; a sibling stays',
		async () => {
			const top = await rawDirectory(id, true);
			const directory = await top.getDirectoryHandle('locked', {
				create: true,
			});
			const file = await directory.getFileHandle('x.md', { create: true });
			await writeHandle(
				await directory.getFileHandle('sibling.md', { create: true }),
				'sibling',
			);
			const writable = await file.createWritable({ keepExistingData: false });
			let fileRemoval: string;
			let ancestorRemoval: string;
			try {
				fileRemoval = await outcome(directory.removeEntry('x.md'));
				ancestorRemoval = await outcome(
					top.removeEntry('locked', { recursive: true }),
				);
				await writable.write(encoder.encode('landed'));
			} finally {
				await writable.close();
			}
			assert(
				fileRemoval !== 'done' && ancestorRemoval !== 'done',
				`file removal ${fileRemoval}; ancestor removal ${ancestorRemoval}`,
			);
			const landed = await (await file.getFile()).text();
			const sibling = await (
				await (await directory.getFileHandle('sibling.md')).getFile()
			).text();
			assert(landed === 'landed', `the file holds ${JSON.stringify(landed)}`);
			assert(
				sibling === 'sibling',
				`the sibling holds ${JSON.stringify(sibling)}`,
			);
			return `file removal ${fileRemoval}; ancestor removal ${ancestorRemoval}; the write landed and the sibling stayed`;
		},
	);

	const directory = await (await rawDirectory(id, true)).getDirectoryHandle(
		'removed',
		{ create: true },
	);
	const exists = (name: string) =>
		outcome(directory.getFileHandle(name)).then((found) => found === 'done');

	// The hazard the recheck is for. Not an assertion: an engine that does
	// not recreate the file only makes the recheck unnecessary.
	const unchecked = await directory.getFileHandle('unchecked.md', {
		create: true,
	});
	await writeHandle(unchecked, 'before');
	await directory.removeEntry('unchecked.md');
	const written = await outcome(writeHandle(unchecked, 'back'));
	record(
		'without a recheck, a stream for a file removed after its handle was taken',
		'note',
		written !== 'done'
			? `refused: ${written}`
			: (await exists('unchecked.md'))
				? 'closing it made the file again'
				: 'closing it left the path absent',
	);

	await check(
		"with a getFile() recheck, a removed file's stream is aborted and the path stays absent",
		async () => {
			const handle = await directory.getFileHandle('rechecked.md', {
				create: true,
			});
			await writeHandle(handle, 'before');
			await directory.removeEntry('rechecked.md');
			const writable = await handle.createWritable({ keepExistingData: false });
			const recheck = await outcome(handle.getFile());
			if (recheck === 'done') await writable.close();
			else await writable.abort();
			assert(recheck === 'NotFoundError', `the recheck found ${recheck}`);
			assert(!(await exists('rechecked.md')), 'the path holds a file');
			return 'getFile() was NotFoundError; after abort the path is absent';
		},
	);
}

async function closing(id: string) {
	await check('closing refuses new saves', async () => {
		const folder = await open(id);
		await folder.close();
		const { error: lateError } = await folder.files.create('late.md', 'x');
		assert(
			lateError?.name === 'Closed',
			`late save: ${lateError?.name ?? 'ok'}`,
		);
		return 'Closed';
	});
}

const RELOAD_KEY = 'opfs-evidence-reload';

/**
 * `?reload=1` writes a folder and reloads to `?reload=2`, which reads it back.
 * Returns whether this page finished the run; `false` while the reload is on
 * its way.
 */
async function reloadCheck(stage: string) {
	if (stage === '1') {
		const folder = await open(runId);
		ok(await folder.files.create('persist.bin', allBytes));
		await folder.close();
		sessionStorage.setItem(RELOAD_KEY, runId);
		location.search = '?reload=2';
		return false;
	}
	const id = sessionStorage.getItem(RELOAD_KEY);
	sessionStorage.removeItem(RELOAD_KEY);
	// The address bar no longer names a stage, so reloading this page or
	// "Run again" starts a full run.
	window.history.replaceState(null, '', location.pathname);
	if (id === null) {
		record(
			'bytes and epicenter.json survive a page reload',
			'note',
			'not run: this page was not reached from a reload check that wrote a folder. Press "Reload persistence check" to run it.',
		);
		return true;
	}
	await check('bytes and epicenter.json survive a page reload', async () => {
		const persistedDefinition = decoder.decode(
			await rawRead(id, DECLARATION_PATH),
		);
		assert(
			persistedDefinition === formatDeclaration(definition),
			'definition did not persist across page reload',
		);
		const folder = await open(id);
		assert(
			decoder.decode(await rawRead(id, DECLARATION_PATH)) ===
				persistedDefinition,
			'reopening changed definition bytes',
		);
		assert(
			sameBytes(ok(await folder.files.read('persist.bin')).bytes, allBytes),
			'bytes',
		);
		return id;
	});
	return true;
}

async function main() {
	running = true;
	runId = `opfs-evidence-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	totals = { pass: 0, fail: 0 };
	element('checks').replaceChildren();
	element('state').dataset.state = 'running';
	element('state').textContent = 'Running…';
	const stage = new URLSearchParams(location.search).get('reload');
	let finished = true;
	try {
		record(
			'environment',
			'note',
			`${navigator.userAgent}; secure ${isSecureContext}; persisted ${await navigator.storage.persisted()}; run ${runId}`,
		);
		if (stage !== null) finished = await reloadCheck(stage);
		else {
			await publication(`${runId}-publication`);
			await filesAndLayout(runId);
			await twoContexts(runId);
			await history(runId);
			await recovery(runId);
			await identity(runId);
			await rowRepair(`${runId}-rows`);
			await streams(`${runId}-streams`);
			await closing(runId);
		}
	} catch (cause) {
		record(
			'run',
			'fail',
			cause instanceof Error ? cause.message : String(cause),
		);
	} finally {
		if (finished) {
			await cleanup();
			element('state').dataset.state = 'done';
			element('state').textContent =
				`Done: ${totals.pass} passed, ${totals.fail} failed. Disposable storage removed.`;
			running = false;
		}
	}
}

let running = false;
element('run').onclick = () => {
	if (running) return;
	// A fresh full run, whatever stage the address bar named.
	window.history.replaceState(null, '', location.pathname);
	void main();
};
element('reload').onclick = () => {
	if (running) return;
	sessionStorage.removeItem(RELOAD_KEY);
	location.search = '?reload=1';
};
void main();
