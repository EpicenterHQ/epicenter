/**
 * A Git repository's history entering Epicenter as a folder (ADR-0826):
 * the export's projections run backwards, a blob that is an LFS pointer
 * read as its object. `epicenter import --git` and the Epicenter app's
 * "Import from Git…" both call `importGit`, each with its computer's Git
 * (`GitHost`).
 *
 * - The repository, a path or a URL, is mirrored into a scratch directory
 *   and read there, so the source is never written. Its Git LFS objects
 *   are fetched into the mirror, or read from a local source's own store.
 * - The first-parent history of the branch (its default unless named)
 *   becomes one change per commit, in order, each keeping the commit's
 *   author (`Name <email>`), time, and message. A side branch arrives only
 *   through the merge on the main line. A commit that changes nothing a
 *   folder keeps makes no change, and one too large for a request lands as
 *   several.
 * - A file keeps its bytes as they are (front matter is not rewritten;
 *   `epicenter format` is its own step); an LFS pointer becomes the bytes
 *   it names. Left out, each with a warning: submodules, symbolic links,
 *   hidden paths (`.gitignore`, `.obsidian/…`: outside a folder's contract,
 *   and never synced), paths not every disk can hold, and a path differing
 *   only in case from one the folder holds.
 * - A tag on a first-parent commit becomes a mark on its change.
 * - The folder is made on the server with `import`, filled, written to a
 *   new, real directory in the Epicenter folder without `.git`, recorded as
 *   synced at the log's head, and only then closed.
 *
 * An import that stops midway (a Git LFS object missing, the network gone)
 * lands the changes it finished first, and its note at the Epicenter
 * folder's root, `.epicenter/imports/<folder-id>.json`, remembers the
 * folder, the source, and the branch until the import closes. `resume`
 * continues it: the changes a source makes are a function of its history,
 * so the run makes them again in order, without a byte of the ones the
 * server's log holds already (an LFS file's version is its pointer's
 * oid), checks the last of those against the log, and lands the rest.
 * `abandonImport` (`@epicenter/folder/node`) deletes a folder that still
 * imports, on the server and here (ADR-0827).
 *
 * With `replaceOriginal`, a local source hands over to Epicenter: it moves
 * aside, its `.git` kept within it as the backup, and a link at its path
 * points into the Epicenter folder. Never without the flag, and never for
 * a source with uncommitted changes.
 */
import { isHiddenPath } from '@epicenter/definition/contract';
import { isMarkName } from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { Version } from '../device/store.js';
import { versionOf } from '../hash.js';
import { pathProblem } from '../paths.js';
import {
	type EpicenterRoot,
	freeName,
	type LocalFolder,
} from '../platform/epicenter-folder.js';
import type { Records } from '../platform/records.js';
import {
	folderRepository,
	type ImportedChange,
	type LoggedChange,
	makeFolder,
	type NamedWrite,
	type RemoteAccount,
} from '../remote/repository.js';
import {
	baseName,
	dirName,
	GitError,
	type GitHost,
	gitText,
	isWithin,
	joinPath,
	readLfsPointer,
} from './host.js';

/** What an import did. */
export type ImportReport = {
	/** The folder made on the server. */
	folder: string;
	/** Where its files were written, in the Epicenter folder. */
	path: string;
	branch: string;
	/** Commits read along the first-parent line. */
	commits: number;
	/** Changes the folder's log holds: one per commit that changed a file the folder keeps. */
	changes: number;
	/** Of those, the changes an earlier run landed, which a resumed run did not send again. */
	resumed: number;
	/** Tags that became marks. */
	marks: string[];
	/** What was left out, and why. */
	warnings: string[];
	/** Where the original went, with `replaceOriginal`. */
	original: { movedTo: string; link: string } | null;
};

/**
 * An import in progress, as this computer remembers it until the import
 * closes: the folder on the server, the source and branch it reads, the
 * name its directory takes, and that directory once it is made.
 */
export type ImportNote = {
	folder: string;
	/** The source as the import read it: a URL, or a repository's absolute path. */
	source: string;
	branch: string;
	name: string;
	directory: string | null;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The most changes, or inline bytes, one import request carries. */
const BATCH_CHANGES = 50;
const BATCH_BYTES = 6 * 1024 * 1024;
/** The most files one imported change writes (`MAX_IMPORTED_FILES` on the server). */
const PART_FILES = 5000;
/** Bytes up to this travel inside a request; larger ones are uploaded first. */
const INLINE_MAX = 16 * 1024;

/** Where the notes of imports in progress are, in the Epicenter folder's `.epicenter`. */
const IMPORTS = 'imports';
const notePath = (folder: string) => `${IMPORTS}/${folder}.json`;

/** Whether `source` names a remote repository rather than a path on this computer. */
export const isUrl = (source: string) =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/]+@[^/:]+:/.test(source);

const isNote = (value: unknown): value is ImportNote => {
	if (typeof value !== 'object' || value === null) return false;
	const note = value as Record<string, unknown>;
	return (
		typeof note.folder === 'string' &&
		typeof note.source === 'string' &&
		typeof note.branch === 'string' &&
		typeof note.name === 'string' &&
		(note.directory === null || typeof note.directory === 'string')
	);
};

/** Every import in progress on this computer, from the notes in `records`' store. */
export async function importsInProgress(
	records: Records,
): Promise<ImportNote[]> {
	const listed = await records.store.list([IMPORTS]);
	if (listed.error !== null) throw new Error(listed.error.message);
	const read = await records.store.read(listed.data.map(({ path }) => path));
	if (read.error !== null) throw new Error(read.error.message);
	const notes: ImportNote[] = [];
	for (const file of read.data) {
		if ('gone' in file) continue;
		try {
			const note: unknown = JSON.parse(decoder.decode(file.bytes));
			if (isNote(note) && file.path === notePath(note.folder)) notes.push(note);
		} catch {
			// A note that does not read is no note.
		}
	}
	return notes.sort((a, b) => (a.folder < b.folder ? -1 : 1));
}

/** Write `note`, over whatever is there: only this import writes it. */
async function writeNote(records: Records, note: ImportNote) {
	const path = notePath(note.folder);
	const read = await records.store.read([path]);
	if (read.error !== null) throw new Error(read.error.message);
	const [file] = read.data;
	const written = await records.store.put(
		path,
		encoder.encode(JSON.stringify(note)),
		file === undefined || 'gone' in file ? null : file.version,
	);
	if (written.error !== null) throw new Error(written.error.message);
}

/** Forget the import of `folder` on this computer. */
export async function removeNote(records: Records, folder: string) {
	const path = notePath(folder);
	const read = await records.store.read([path]);
	if (read.error !== null) throw new Error(read.error.message);
	const [file] = read.data;
	if (file === undefined || 'gone' in file) return;
	const removed = await records.store.put(path, null, file.version);
	if (removed.error !== null && removed.error.name !== 'Moved')
		throw new Error(removed.error.message);
}

/** Each blob's bytes by id, read from `mirror` in one `git cat-file --batch`. */
async function readBlobs(
	host: GitHost,
	mirror: string,
	ids: readonly string[],
): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return out;
	const run = await host.run(['cat-file', '--batch'], {
		cwd: mirror,
		input: encoder.encode(`${unique.join('\n')}\n`),
	});
	if (run.code !== 0) throw new Error(`git cat-file failed: ${run.stderr}`);
	const bytes = run.stdout;
	let at = 0;
	for (const id of unique) {
		const end = bytes.indexOf(10, at);
		const header = decoder.decode(bytes.subarray(at, end));
		const size = Number(header.split(' ')[2]);
		if (!header.startsWith(id) || !Number.isSafeInteger(size))
			throw new Error(`git cat-file answered ${header} for ${id}`);
		out.set(id, bytes.slice(end + 1, end + 1 + size));
		at = end + 1 + size + 1;
	}
	return out;
}

/** One path a commit changed, as `git diff-tree --raw -z` reads it. */
type RawEntry = { mode: string; id: string; status: string; path: string };

function readRaw(output: Uint8Array): RawEntry[] {
	const fields = decoder.decode(output).split('\0');
	const entries: RawEntry[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const meta = fields[index] as string;
		const path = fields[index + 1] as string;
		const [, newMode = '', , newId = '', status = ''] = meta
			.replace(/^:/, '')
			.split(' ');
		entries.push({ mode: newMode, id: newId, status, path });
	}
	return entries;
}

/**
 * A file a change writes, before its bytes are read: its version and size
 * are known from the blob, or from an LFS pointer's oid and size, and its
 * bytes are read only when the change is sent.
 */
type Write =
	| {
			path: string;
			expect: string | null;
			version: string;
			size: number;
			bytes: () => Promise<Uint8Array>;
	  }
	| NamedWrite;

/** A change the source makes, before its bytes are read. */
type Planned = {
	commit: string;
	author: string;
	at: Date;
	message: string;
	files: Write[];
};

/** Whether `change`, as the server's log holds it, is the change `planned` makes. */
function isPlanned(change: LoggedChange, planned: Planned) {
	if (
		change.author !== planned.author ||
		Date.parse(change.at) !== planned.at.getTime() ||
		(change.message ?? '') !== planned.message
	)
		return false;
	const wrote = new Map(
		change.files.map(({ path, version }) => [path, version as string | null]),
	);
	return (
		wrote.size === planned.files.length &&
		planned.files.every((file) => wrote.get(file.path) === file.version)
	);
}

/**
 * Import the repository `source` (a URL, or a repository's absolute path)
 * into a new folder held by `account`'s person, through `host`'s Git, and
 * write it into `root`, named `name` (or for the repository); or, with
 * `resume`, continue the import in progress of `source` (the only one when
 * none is named). See the header.
 */
export async function importGit(options: {
	host: GitHost;
	source?: string;
	branch?: string;
	account: RemoteAccount;
	root: EpicenterRoot;
	name?: string;
	replaceOriginal?: boolean;
	resume?: boolean;
}): Promise<Result<ImportReport, GitError>> {
	try {
		return Ok(await runImport(options));
	} catch (cause) {
		return GitError.Failed({ cause });
	}
}

async function runImport({
	host,
	source: given,
	branch: named,
	account,
	root,
	name,
	replaceOriginal = false,
	resume = false,
}: Parameters<typeof importGit>[0]): Promise<ImportReport> {
	const opened = await root.records();
	if (opened.error !== null) throw new Error(opened.error.message);
	const records = opened.data;
	let note: ImportNote | null = null;
	if (resume) {
		const waiting = (await importsInProgress(records)).filter(
			(one) =>
				(given === undefined || one.source === given) &&
				(named === undefined || one.branch === named),
		);
		if (waiting.length === 0)
			throw new Error(
				given === undefined
					? 'No import waits to resume on this computer.'
					: `No import of ${given} waits to resume on this computer.`,
			);
		if (waiting.length > 1)
			throw new Error(
				`Several imports wait to resume; name one with --git: ${waiting.map(({ source, branch }) => `${source} (${branch})`).join(', ')}`,
			);
		note = waiting[0] as ImportNote;
	} else if (given === undefined)
		throw new Error('Name the repository to read: --git <path or URL>.');
	const source = note?.source ?? (given as string);
	const local = isUrl(source) ? null : source;
	if (replaceOriginal) {
		if (local === null)
			throw new Error(
				'--replace-original hands over a repository on this computer, not a URL',
			);
		// A root in a window knows its path once it listed.
		const listed = await root.list();
		if (listed.error !== null) throw new Error(listed.error.message);
		if (isWithin(local, root.path))
			throw new Error(`${local} is in the Epicenter folder already`);
		const status = await gitText(host, ['status', '--porcelain'], {
			cwd: local,
		});
		if (status.trim() !== '')
			throw new Error(
				`${local} has uncommitted changes; commit or stash them first, so the folder holds what Git holds`,
			);
	}
	const scratch = await host.scratch();
	const mirror = joinPath(scratch.path, 'mirror.git');
	const warnings: string[] = [];
	try {
		await gitText(host, ['clone', '--mirror', '--quiet', source, mirror]);
		const branch =
			note?.branch ??
			named ??
			(
				await gitText(host, ['symbolic-ref', '--short', 'HEAD'], {
					cwd: mirror,
				})
			).trim();
		const ref = `refs/heads/${branch}`;
		if (
			(
				await host.run(['rev-parse', '--verify', '--quiet', ref], {
					cwd: mirror,
				})
			).code !== 0
		)
			throw new Error(`${source} has no branch ${branch}`);
		const commits = (
			await gitText(host, ['rev-list', '--first-parent', '--reverse', ref], {
				cwd: mirror,
			})
		)
			.split('\n')
			.filter(Boolean);
		if (commits.length === 0) throw new Error(`${branch} has no commits`);

		/** An LFS object's bytes: from the mirror, fetched when first asked, or a local source's store. */
		let fetched = false;
		const stores = [
			mirror,
			...(local === null ? [] : [joinPath(local, '.git'), local]),
		];
		const lfsObject = async (oid: string) => {
			for (const store of stores) {
				const bytes = await host.lfsObject(store, oid);
				if (bytes !== null) return bytes;
			}
			if (!fetched) {
				fetched = true;
				const run = await host.run(['lfs', 'fetch', '--all', 'origin'], {
					cwd: mirror,
				});
				if (run.code !== 0)
					warnings.push(`git lfs fetch failed: ${run.stderr.trim()}`);
				return host.lfsObject(mirror, oid);
			}
			return null;
		};

		/** The bytes a blob stands for: an LFS pointer's object, or the blob itself. */
		const bytesOf = async (blob: Uint8Array, path: string) => {
			const pointer = readLfsPointer(blob);
			if (pointer === null) return blob;
			const object = await lfsObject(pointer.oid);
			if (object === null)
				throw new Error(
					`${path}'s Git LFS object ${pointer.oid} could not be fetched; fetch it into ${source} (git lfs fetch --all), then resume the import of ${source}`,
				);
			return object;
		};

		let folder: string;
		/** The changes the folder's log held when this run started, and the last of them. */
		let landed = 0;
		let newest: LoggedChange | null = null;
		if (note === null) {
			const made = await makeFolder(account, { importing: true });
			if (made.error !== null) throw new Error(made.error.message);
			folder = made.data;
			note = {
				folder,
				source,
				branch,
				name:
					name ??
					baseName(local ?? source.replace(/\/+$/, '')).replace(/\.git$/, ''),
				directory: null,
			};
			await writeNote(records, note);
		} else {
			folder = note.folder;
			const head = await folderRepository(account, folder).log({ limit: 1 });
			if (head.error !== null)
				throw new Error(
					`The import's folder ${folder} could not be read (${head.error.message}); give it up with epicenter import --abandon ${folder}`,
				);
			newest = head.data[0] ?? null;
			landed = newest?.seq ?? 0;
		}
		const repository = folderRepository(account, folder);

		/** What the folder holds now, by path: its version and the blob it came from. */
		const held = new Map<string, { version: string; blob: string }>();
		/** Paths left out for good: a case clash or a name some disk cannot hold. */
		const refused = new Set<string>();
		const warned = new Set<string>();
		const warn = (path: string, why: string) => {
			if (warned.has(path)) return;
			warned.add(path);
			warnings.push(`${path}: ${why}`);
		};
		/** Commit id to the seq of the last change made at or before it. */
		const seqOfCommit = new Map<string, number>();
		/** Changes the source makes, counted in order: their seqs in the folder's log. */
		let seq = 0;
		let pending: ImportedChange[] = [];
		let pendingBytes = 0;

		const flush = async (): Promise<void> => {
			if (pending.length === 0) return;
			const batch = pending;
			pending = [];
			pendingBytes = 0;
			const sent = await repository.importChanges(batch);
			if (sent.error !== null) throw new Error(sent.error.message);
			if ('cursor' in sent.data) return;
			throw new Error(
				'refused' in sent.data
					? `the server refused ${sent.data.refused}: ${sent.data.reason}`
					: 'moved' in sent.data
						? `the folder moved during the import at ${sent.data.moved.map(({ path }) => path).join(', ')}`
						: 'the server lacks bytes it was sent',
			);
		};

		/**
		 * Take the next change the source makes: one the log holds already
		 * is checked (the last of them) and never sent; any other has its
		 * bytes read and waits to be sent.
		 */
		const take = async (planned: Planned) => {
			seq++;
			if (seq <= landed) {
				if (seq === landed && newest !== null && !isPlanned(newest, planned))
					throw new Error(
						`The folder ${folder} holds a change ${seq} this repository does not make; it is not this import's folder. Give it up with epicenter import --abandon ${folder}.`,
					);
				return;
			}
			const files: ImportedChange['files'] = [];
			let size = 0;
			for (const file of planned.files) {
				if (!('bytes' in file)) {
					files.push(file);
					continue;
				}
				const bytes = await file.bytes();
				files.push({ path: file.path, expect: file.expect as never, bytes });
				if (bytes.byteLength <= INLINE_MAX) size += bytes.byteLength;
			}
			if (pending.length > 0 && pendingBytes + size > BATCH_BYTES)
				await flush();
			pending.push({
				author: planned.author,
				at: planned.at,
				message: planned.message,
				files,
			});
			pendingBytes += size;
			if (pending.length >= BATCH_CHANGES || pendingBytes >= BATCH_BYTES)
				await flush();
		};

		const folded = new Map<string, string>();
		const fold = (path: string) => path.normalize('NFC').toLowerCase();
		let sending = false;
		try {
			for (const [index, commit] of commits.entries()) {
				const parent = index === 0 ? null : (commits[index - 1] as string);
				const raw = readRaw(
					(
						await host.run(
							[
								'diff-tree',
								'-r',
								'-z',
								'--raw',
								'--no-renames',
								'--no-commit-id',
								...(parent === null ? ['--root', commit] : [parent, commit]),
							],
							{ cwd: mirror },
						)
					).stdout,
				);
				const meta = await gitText(
					host,
					['log', '-1', '--format=%an%x00%ae%x00%at%x00%B', commit],
					{ cwd: mirror },
				);
				const [author = '', email = '', at = '0', ...rest] = meta.split('\0');
				const message = rest.join('\0').replace(/\n+$/, '');
				const writes: RawEntry[] = [];
				for (const entry of raw) {
					const { path, mode } = entry;
					if (refused.has(path)) continue;
					if (mode === '160000') {
						warn(path, 'a submodule, left out');
						continue;
					}
					if (mode === '120000') {
						warn(path, 'a symbolic link, left out');
						continue;
					}
					if (isHiddenPath(path)) {
						warn(path, 'hidden, so outside the folder, left out');
						continue;
					}
					const problem = pathProblem(path);
					if (problem !== undefined) {
						refused.add(path);
						warn(path, `${problem}, left out`);
						continue;
					}
					writes.push(entry);
				}
				const blobs = await readBlobs(
					host,
					mirror,
					writes.filter(({ status }) => status !== 'D').map(({ id }) => id),
				);
				const files: Write[] = [];
				for (const entry of writes) {
					const before = held.get(entry.path);
					if (entry.status === 'D' || /^0+$/.test(entry.id)) {
						if (before === undefined) continue;
						files.push({
							path: entry.path,
							expect: before.version as Version,
							version: null,
						} satisfies NamedWrite);
						held.delete(entry.path);
						folded.delete(fold(entry.path));
						continue;
					}
					const clash = folded.get(fold(entry.path));
					if (
						before === undefined &&
						clash !== undefined &&
						clash !== entry.path
					) {
						refused.add(entry.path);
						warn(entry.path, `differs only in case from ${clash}, left out`);
						continue;
					}
					const blob = blobs.get(entry.id) as Uint8Array;
					// An LFS file's version is its pointer's oid: no bytes read to know it.
					const pointer = readLfsPointer(blob);
					const version = pointer?.oid ?? (await versionOf(blob));
					if (before?.version === version) {
						held.set(entry.path, { version, blob: entry.id });
						continue;
					}
					const path = entry.path;
					files.push({
						path,
						expect: before?.version ?? null,
						version,
						size: pointer?.size ?? blob.byteLength,
						bytes: () => bytesOf(blob, path),
					});
					held.set(path, { version, blob: entry.id });
					folded.set(fold(path), path);
				}
				if (files.length > 0) {
					// A commit too large for one request lands as several changes,
					// each with its author, time, and message; the commit maps to the last.
					let part: Write[] = [];
					let partBytes = 0;
					const planned = () => ({
						commit,
						author: `${author} <${email}>`,
						at: new Date(Number(at) * 1000),
						message,
						files: part,
					});
					for (const file of files) {
						const size =
							'bytes' in file && file.size <= INLINE_MAX ? file.size : 0;
						if (
							part.length > 0 &&
							(part.length >= PART_FILES || partBytes + size > BATCH_BYTES)
						) {
							await take(planned());
							part = [];
							partBytes = 0;
						}
						part.push(file);
						partBytes += size;
					}
					await take(planned());
				}
				seqOfCommit.set(commit, seq);
			}
			sending = true;
			await flush();
		} catch (cause) {
			// What finished lands, so a resumed import starts after it.
			if (!sending) await flush();
			throw cause;
		}
		if (seq < landed)
			throw new Error(
				`The folder ${folder} holds ${landed} changes and this repository makes ${seq}; it is not this import's folder. Give it up with epicenter import --abandon ${folder}.`,
			);

		// Each tag on the first-parent line becomes a mark on its change.
		const marks: string[] = [];
		const tags = await gitText(
			host,
			[
				'for-each-ref',
				'--format=%(refname:short)%00%(objectname)%00%(*objectname)',
				'refs/tags',
			],
			{ cwd: mirror },
		);
		for (const line of tags.split('\n').filter(Boolean)) {
			const [tag = '', object = '', peeled = ''] = line.split('\0');
			const target = peeled || object;
			const at = seqOfCommit.get(target);
			if (!isMarkName(tag)) {
				warnings.push(`tag ${tag}: not a name a mark can have, left out`);
				continue;
			}
			if (at === undefined) {
				warnings.push(
					`tag ${tag}: not on ${branch}'s first-parent line, left out`,
				);
				continue;
			}
			if (at === 0) {
				warnings.push(`tag ${tag}: marks a commit before any file, left out`);
				continue;
			}
			const marked = await repository.mark(tag, { seq: at });
			if (marked.error !== null) throw new Error(marked.error.message);
			// A resumed import finds the marks an earlier run made.
			if ('taken' in marked.data && marked.data.taken.seq !== at)
				throw new Error(
					`${tag} marks change ${marked.data.taken.seq} in the folder, not ${at}`,
				);
			marks.push(tag);
		}

		// The files, written into a real directory in the Epicenter folder.
		const directory = await directoryFor(root, records, note);
		const there = await directory.store.list(['']);
		if (there.error !== null) throw new Error(there.error.message);
		const listed = new Map(
			there.data.map(({ path, version }) => [path, version]),
		);
		const last = await readBlobs(
			host,
			mirror,
			[...held.values()].map(({ blob }) => blob),
		);
		const files: Record<string, string> = {};
		for (const [path, { version, blob }] of held) {
			files[path] = version;
			const now = listed.get(path) ?? null;
			if (now === version) continue;
			const bytes = await bytesOf(last.get(blob) as Uint8Array, path);
			const put = await directory.store.put(path, bytes, now);
			if (put.error !== null) throw new Error(`${path}: ${put.error.message}`);
		}
		const head = await repository.changes(null);
		if (head.error !== null) throw new Error(head.error.message);
		const recorded = await records.list();
		if (recorded.error !== null) throw new Error(recorded.error.message);
		const before = recorded.data.find(({ record }) => record.folder === folder);
		const written = await records.write(
			{
				folder,
				name: directory.name,
				inode: directory.identity?.inode ?? '',
				birthtime: directory.identity?.birthtime ?? null,
				cursor: head.data.cursor,
				files: files as Record<string, Version>,
			},
			before?.version ?? null,
		);
		if (written.error !== null) throw new Error(written.error.message);
		const done = await repository.importDone();
		if (done.error !== null) throw new Error(done.error.message);
		await removeNote(records, folder);

		let original: ImportReport['original'] = null;
		if (replaceOriginal && local !== null) {
			const aside = joinPath(
				dirName(local),
				freeName(`${baseName(local)} (before Epicenter)`, []),
			);
			await host.handOver({ from: local, to: aside, target: directory.path });
			original = { movedTo: aside, link: local };
		}
		return {
			folder,
			path: directory.path,
			branch,
			commits: commits.length,
			changes: seq,
			resumed: Math.min(landed, seq),
			marks,
			warnings,
			original,
		};
	} finally {
		await scratch.remove();
	}
}

/**
 * The directory the import of `note` writes: the one an earlier run of it
 * made, or a new one, named for the import, a free name when taken, which
 * the note then remembers.
 */
async function directoryFor(
	root: EpicenterRoot,
	records: Records,
	note: ImportNote,
): Promise<LocalFolder> {
	const present = await root.list();
	if (present.error !== null) throw new Error(present.error.message);
	if (note.directory !== null) {
		const made = present.data.folders.find(
			({ name }) => name === note.directory,
		);
		if (made !== undefined) return made;
	}
	const made = await root.make(
		freeName(note.name || note.folder, [
			...present.data.folders.map(({ name }) => name),
			...present.data.outside.map(({ name }) => name),
			...present.data.unreadable.map(({ name }) => name),
		]),
	);
	if (made.error !== null) throw new Error(made.error.message);
	note.directory = made.data.name;
	await writeNote(records, note);
	return made.data;
}
