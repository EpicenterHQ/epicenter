/**
 * EVIDENCE: browser-folder acceptance checks in a real browser.
 *
 * Every check opens folders through the production browser opener, in this
 * origin's real OPFS, Web Locks, and BroadcastChannel, under fresh disposable
 * IDs, each the directory of that name at the origin's private root. A same-origin iframe (`peer.ts`) is a second
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
 * The interrupted-update check builds what a tab that closed mid-publication
 * leaves: the branch at the commit before, and files partly written. It
 * writes those raw entries with the browser's own OPFS API, then uses only
 * the folder's public methods. No remote is reached.
 *
 * The address check opens a folder and finds nothing written, then writes
 * once and finds the directory, its repository, and its declaration. A
 * directory someone else wrote under an ID is that folder. The row check reads malformed and
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
	DEFINITION_PATH,
	defineFolder,
	defineTable,
	type Folder,
	field,
	formatDefinition,
	hashBytes,
	openFolder,
} from '../../src/browser.js';
import type { PeerReply, PeerRequest } from './peer.js';

type Status = 'pass' | 'fail' | 'note';

const definition = defineFolder({
	tables: { rows: defineTable({ fields: { title: field.string() } }) },
});
const author = { name: 'Evidence', email: 'evidence@example.test' };
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
	options: { definition?: typeof definition } = {},
) {
	used.add(id);
	const { data: folder, error: openError } = await openFolder({
		app: id,
		definition: options.definition ?? definition,
		browser: { author },
	});
	if (openError !== null) throw new Error(`open refused: ${openError.message}`);
	opened.push(folder);
	return folder;
}

/** Make `path` hold `content`, whatever is there now: a write from what was read. */
async function put(
	folder: Folder<typeof definition>,
	path: string,
	content: string | Uint8Array,
): Promise<Result<unknown, { name: string; message: string }>> {
	const { data: current, error } = await folder.files.read(path);
	if (error !== null && error.name !== 'NotFound') return { data: null, error };
	return folder.write(path, current?.bytes ?? null, content);
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
	return origin.getDirectoryHandle(id, { create });
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

/** Whether the folder's directory, or a directory inside it, exists. */
async function rawDirectoryExists(id: string, path = '') {
	try {
		let directory = await rawDirectory(id);
		for (const part of path.split('/').filter(Boolean))
			directory = await directory.getDirectoryHandle(part);
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
			await origin.removeEntry(id, { recursive: true });
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
			`${id}/${path}`,
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
		`${id}/.git holds ${git} files and is never listed. ` +
		`${mismatches} mismatches.`;
	return mismatches;
}

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

/** Publication uses real OPFS; history-enabled acquisition is a separate case. */
async function publication(id: string) {
	await check(
		'opening writes nothing; the first write publishes the definition, without manual-mode history',
		async () => {
			const folder = await open(id);
			assert(!(await rawDirectoryExists(id)), 'opening made the directory');
			ok(await folder.write('rows/first.md', null, '---\ntitle: First\n---\n'));
			const expected = formatDefinition(definition);
			const stored = decoder.decode(await rawRead(id, DEFINITION_PATH));
			assert(stored === expected, `stored ${stored}`);
			// The first commit makes the repository, not the first write.
			assert(
				!(await rawExists(id, '.git/HEAD')),
				'the first write made a repository',
			);
			assert(
				ok(await folder.git.log(10)).length === 0,
				'manual mode committed',
			);
			return `epicenter.json: ${stored}`;
		},
	);
	await check(
		"each handle's first write replaces a manual description, and changed declarations leave row bytes intact",
		async () => {
			const folder = await open(id);
			ok(
				await folder.write(
					'rows/kept.md',
					null,
					'---\ntitle: Kept\n---\nSaved body\n',
				),
			);
			const before = await rawRead(id, 'rows/kept.md');
			ok(await put(folder, DEFINITION_PATH, 'manual malformed description'));
			await folder.close();
			const reopened = await open(id);
			assert(
				decoder.decode(await rawRead(id, DEFINITION_PATH)) ===
					'manual malformed description',
				'reopening wrote',
			);
			ok(
				await reopened.write(
					'rows/second.md',
					null,
					'---\ntitle: Second\n---\n',
				),
			);
			assert(
				decoder.decode(await rawRead(id, DEFINITION_PATH)) ===
					formatDefinition(definition),
				'manual description stayed after a write',
			);
			await reopened.close();
			const changed = defineFolder({
				...definition,
				title: 'Changed publication',
			});
			const third = await open(id, { definition: changed });
			ok(await third.write('rows/third.md', null, '---\ntitle: Third\n---\n'));
			assert(
				decoder.decode(await rawRead(id, DEFINITION_PATH)) ===
					formatDefinition(changed),
				'changed declaration was not published',
			);
			assert(
				sameBytes(await rawRead(id, 'rows/kept.md'), before),
				'row bytes changed',
			);
			return 'opening wrote nothing; the next write replaced the manual description; changed title published; saved Markdown unchanged';
		},
	);
	await check(
		'publication makes no commit, and the same declaration written again leaves nothing to commit',
		async () => {
			const historyId = `${id}-history`;
			const first = await open(historyId);
			ok(await first.write('rows/a.md', null, '---\ntitle: A\n---\n'));
			assert(ok(await first.git.log(10)).length === 0, 'writing made a commit');
			const made = await first.git.commit();
			assert(made.status === 'committed', `first commit ${made.status}`);
			const commits = ok(await first.git.log(10));
			assert(commits.length === 1, `initial commits ${commits.length}`);
			await first.close();
			const second = await open(historyId);
			ok(await put(second, 'rows/a.md', '---\ntitle: A\n---\n'));
			const reopened = await second.git.commit();
			assert(reopened.status === 'unchanged', `reopening ${reopened.status}`);
			const after = ok(await second.git.log(10));
			assert(
				JSON.stringify(after) === JSON.stringify(commits),
				'the same declaration added history',
			);
			assert(
				ok(await second.git.status()).changes.length === 0,
				'committed tree is dirty',
			);
			return `one commit ${commits[0]?.oid}; the same bytes again keep it`;
		},
	);
}

async function filesAndLayout(id: string) {
	const large = randomBytes(4 * 1024 * 1024);
	await check('one path is one stored file; .git is private', async () => {
		const folder = await open(id);
		assert(
			folder.location.kind === 'opfs' && folder.location.directory === id,
			`location ${JSON.stringify(folder.location)}`,
		);
		ok(await folder.write('notes/a.md', null, '# A\n'));
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
			ok(await folder.write('bytes.bin', null, allBytes));
			ok(await folder.write('empty.txt', null, ''));
			ok(await folder.write('large.bin', null, large));
			ok(await folder.write('ünïcode/ノート.md', null, 'text'));
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
				ok(await folder.write(`names/${name}`, null, name));
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
		'the bytes a read returns stay after the path is replaced',
		async () => {
			const folder = await open(id);
			ok(await folder.write('take.bin', null, large));
			const read = ok(await folder.files.read('take.bin'));
			const { directory, name } = await rawParent(id, 'take.bin');
			const snapshot = await (await directory.getFileHandle(name)).getFile();
			ok(await folder.write('take.bin', large, 'replaced'));
			assert(sameBytes(read.bytes, large), 'the bytes read changed');
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
			return 'the bytes read kept 4 MiB';
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
						folder.write(path, null, 'main'),
						other.ask({ kind: 'write', path, from: null, content: 'peer' }),
					]);
					const winners = Number(mineError === null) + Number(theirs.ok);
					const loser = mineError?.name ?? theirs.error;
					assert(
						winners === 1 && loser === 'Occupied',
						`round ${round}: ${winners} winners, ${loser}`,
					);
				}
				return '10 rounds';
			},
		);

		await check(
			'across contexts, two writes from one version both land, the later merged over the earlier',
			async () => {
				const folder = await open(id);
				for (let round = 0; round < 10; round++) {
					const path = `race/replace-${round}.md`;
					ok(await folder.write(path, null, 'base'));
					const [mine, theirs] = await Promise.all([
						folder.write(path, 'base', 'main'),
						other.ask({ kind: 'write', path, from: 'base', content: 'peer' }),
					]);
					const landed = ok(mine);
					assert(theirs.ok, `round ${round}: the peer's write failed`);
					// The later one read the earlier one's bytes and overrode its line.
					const overrides =
						Number(landed.overridden.length > 0) +
						Number((theirs.overridden ?? 0) > 0);
					const stored = decoder.decode(
						ok(await folder.files.read(path)).bytes,
					);
					assert(
						overrides === 1 && ['main', 'peer'].includes(stored),
						`round ${round}: ${overrides} overrides, ${stored}`,
					);
				}
				return '10 rounds';
			},
		);

		await check('a save is hinted to the other context', async () => {
			const folder = await open(id);
			ok(await folder.write('hinted.md', null, 'x'));
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
				ok(await folder.write('big.bin', null, first));
				const reading = other.ask({
					kind: 'readFor',
					path: 'big.bin',
					ms: 2000,
				});
				for (let round = 0; round < 6; round++)
					ok(await put(folder, 'big.bin', round % 2 === 0 ? second : first));
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
			assert(
				ok(await folder.git.status()).changes.length === 0,
				'status is not clean after reopening',
			);
			return commit.oid;
		},
	);
}

/**
 * A folder whose last commit's publication stopped partway, as a closed tab
 * leaves it: the branch is still at the commit before, the index already
 * matches the published commit, `a.md` already holds its new bytes, and
 * `c.md`, new in the published commit, was never written. Nothing records
 * the update (ADR-0545).
 */
async function interrupted(id: string) {
	await check(
		'an update a closed tab cut off is changed files, and a commit goes ahead',
		async () => {
			const folder = await open(id);
			ok(await folder.write('a.md', null, '1'));
			ok(await folder.write('b.md', null, '1'));
			const before = await folder.git.commit();
			assert(before.status === 'committed', `first commit ${before.status}`);
			ok(await put(folder, 'a.md', '2'));
			ok(await folder.write('c.md', null, 'new'));
			const after = await folder.git.commit();
			assert(after.status === 'committed', `second commit ${after.status}`);
			await closeAll();
			await rawWrite(
				id,
				'.git/refs/heads/main',
				encoder.encode(`${before.oid}\n`),
			);
			await rawRemove(id, 'c.md');

			const reopened = await open(id);
			const changes = ok(await reopened.git.status()).changes.map(
				(change) => change.path,
			);
			assert(changes.join() === 'a.md', `status ${changes}`);
			const commit = await reopened.git.commit();
			assert(commit.status === 'committed', `commit ${commit.status}`);
			await showLayout(reopened, id);
			return 'status shows a.md; the commit records it';
		},
	);
}

async function address(id: string) {
	await check(
		'a folder is the directory its ID names, and a directory someone else wrote there is that folder',
		async () => {
			const found = `${id}-found`;
			await rawWrite(found, 'found.txt', encoder.encode('found'));
			const folder = await open(found);
			const listed = ok(await folder.files.list()).files.map(
				(file) => file.path,
			);
			assert(listed.join() === 'found.txt', `listed ${listed}`);
			assert(
				!(await rawDirectoryExists(found, '.git')),
				'opening wrote a repository beside found.txt',
			);
			const made = await folder.git.commit();
			assert(made.status === 'committed', `commit ${made.status}`);
			return `found.txt opened as the folder and committed (${made.status})`;
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
			ok(await folder.write('rows/broken.md', null, brokenText));
			ok(await folder.write('rows/untitled.md', null, untitledText));
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
			const repaired = '---\ntitle: Repaired\n---\n';
			// A row that does not read is repaired as text, over the text it holds.
			ok(await folder.write(broken.path, broken.text, repaired));
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
/**
 * What the browser's own `move()` does, which a folder's new file relies on:
 * it is written to `.git/epicenter/scratch` and moved into place where the
 * files lock has just found nothing. The overwrite and open-stream cases are
 * notes: storage never moves onto a name that is there.
 */
async function moves(id: string) {
	used.add(id);
	const top = await rawDirectory(id, true);
	const into = await top.getDirectoryHandle('into', { create: true });
	const fresh = async (name: string, text: string) => {
		const handle = await top.getFileHandle(name, { create: true });
		await writeHandle(handle, text);
		return handle as FileSystemFileHandle & {
			move?(directory: FileSystemDirectoryHandle, name: string): Promise<void>;
		};
	};
	await check(
		'a file moves into an absent name in another directory, whole, and leaves its old name',
		async () => {
			const staged = await fresh('staged.md', 'moved');
			assert(
				typeof staged.move === 'function',
				'FileSystemFileHandle.move is missing',
			);
			await staged.move(into, 'target.md');
			const moved = await (
				await (await into.getFileHandle('target.md')).getFile()
			).text();
			assert(moved === 'moved', `the target holds ${JSON.stringify(moved)}`);
			const left = await outcome(top.getFileHandle('staged.md'));
			assert(left !== 'done', 'the old name is still there');
			return `target holds "moved"; old name ${left}`;
		},
	);
	const existing = await into.getFileHandle('existing.md', { create: true });
	await writeHandle(existing, 'before');
	const onto = await fresh('onto.md', 'after');
	const movedOnto = await outcome(onto.move!(into, 'existing.md'));
	const after = await (
		await (await into.getFileHandle('existing.md')).getFile()
	).text();
	record(
		'a move onto an existing name',
		'note',
		`${movedOnto}; the name holds ${JSON.stringify(after)}`,
	);
	const streamed = await into.getFileHandle('open.md', { create: true });
	await writeHandle(streamed, 'before');
	const writable = await streamed.createWritable({ keepExistingData: false });
	const whileOpen = await fresh('while-open.md', 'moved in');
	let movedWhileOpen: string;
	try {
		movedWhileOpen = await outcome(whileOpen.move!(into, 'open.md'));
		await writable.write(encoder.encode('stream'));
	} finally {
		await outcome(writable.close());
	}
	const held = await (
		await (await into.getFileHandle('open.md')).getFile()
	).text();
	record(
		'a move onto a name with an open write stream',
		'note',
		`${movedWhileOpen}; after the stream closed the name holds ${JSON.stringify(held)}`,
	);
	await check(
		"a folder's new file appears whole, and leaves nothing in its scratch directory",
		async () => {
			const folder = await open(id);
			ok(await folder.write('new/whole.md', null, 'whole'));
			const git = await (await rawDirectory(id)).getDirectoryHandle('.git');
			const epicenter = await git.getDirectoryHandle('epicenter');
			const scratch = (
				await rawEntries(await epicenter.getDirectoryHandle('scratch'))
			).length;
			assert(scratch === 0, `${scratch} files left in scratch`);
			const text = new TextDecoder().decode(await rawRead(id, 'new/whole.md'));
			assert(text === 'whole', `the file holds ${JSON.stringify(text)}`);
			await closeAll();
			return 'the file holds "whole"; scratch is empty';
		},
	);
}

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
		const { error: lateError } = await folder.write('late.md', null, 'x');
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
		ok(await folder.write('persist.bin', null, allBytes));
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
			await rawRead(id, DEFINITION_PATH),
		);
		assert(
			persistedDefinition === formatDefinition(definition),
			'definition did not persist across page reload',
		);
		const folder = await open(id);
		assert(
			decoder.decode(await rawRead(id, DEFINITION_PATH)) ===
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
			await interrupted(`${runId}-interrupted`);
			await address(runId);
			await rowRepair(`${runId}-rows`);
			await streams(`${runId}-streams`);
			await moves(`${runId}-moves`);
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
