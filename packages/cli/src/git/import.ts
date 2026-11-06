/**
 * `epicenter import --git <repository> [--branch <name>]` (ADR-0826): a
 * Git repository's history entering Epicenter as a folder: the export's
 * projections run backwards, a blob that is an LFS pointer read as its
 * object.
 *
 * - The repository, a path or a URL, is mirrored into a scratch directory
 *   and read there, so the source is never written. Its Git LFS objects
 *   are fetched into the mirror, or read from a local source's own store.
 * - The first-parent history of the branch (its default unless named)
 *   becomes one change per commit, in order, each keeping the commit's
 *   author (`Name <email>`), time, and message. A side branch arrives only
 *   through the merge on the main line. A commit that changes nothing a
 *   folder keeps makes no change.
 * - A file keeps its bytes as they are (front matter is not rewritten;
 *   `epicenter format` is its own step); an LFS pointer becomes the bytes
 *   it names. Left out, each with a warning: submodules, symbolic links,
 *   hidden paths (`.gitignore`, `.obsidian/…`: outside a folder's contract,
 *   and never synced), paths not every disk can hold, and a path differing
 *   only in case from one the folder holds.
 * - A tag on a first-parent commit becomes a mark on its change.
 * - The folder is made on the server with `import`, filled, and closed;
 *   then its files are written to a new, real directory in the Epicenter
 *   folder, without `.git`, and recorded as synced at the log's head.
 *
 * With `replaceOriginal`, a local source hands over to Epicenter: it moves
 * aside, its `.git` kept within it as the backup, and a link at its path
 * points into the Epicenter folder. Never without the flag, and never for
 * a source with uncommitted changes.
 */
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import { isMarkName } from '@epicenter/definition/site';
import { pathProblem } from '@epicenter/folder/node';
import {
	type EpicenterRoot,
	freeName,
	makeFolder,
	type RemoteAccount,
} from '@epicenter/folder/platform';
import {
	folderRepository,
	type ImportedChange,
	type NamedWrite,
} from '@epicenter/folder/sync';
import { git, gitText, lfsObjectPath, readLfsPointer } from './run.ts';

/** What an import did. */
export type ImportReport = {
	/** The folder made on the server. */
	folder: string;
	/** Where its files were written, in the Epicenter folder. */
	path: string;
	branch: string;
	/** Commits read along the first-parent line. */
	commits: number;
	/** Changes made: one per commit that changed a file the folder keeps. */
	changes: number;
	/** Tags that became marks. */
	marks: string[];
	/** What was left out, and why. */
	warnings: string[];
	/** Where the original went, with `replaceOriginal`. */
	original: { movedTo: string; link: string } | null;
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

/** Whether `source` names a remote repository rather than a path on this computer. */
const isUrl = (source: string) =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^/]+@[^/:]+:/.test(source);

/** Each blob's bytes by id, read from `mirror` in one `git cat-file --batch`. */
async function readBlobs(
	mirror: string,
	ids: readonly string[],
): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return out;
	const run = await git(['cat-file', '--batch'], {
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
 * Import the repository `source` (a path or a URL) into a new folder held
 * by `account`'s person, and write it into `root`, named `name` (or for the
 * repository). See the header.
 */
export async function importGit({
	source,
	branch: named,
	account,
	root,
	name,
	replaceOriginal = false,
}: {
	source: string;
	branch?: string;
	account: RemoteAccount;
	root: EpicenterRoot;
	name?: string;
	replaceOriginal?: boolean;
}): Promise<ImportReport> {
	const local = isUrl(source) ? null : resolve(source);
	if (replaceOriginal) {
		if (local === null)
			throw new Error(
				'--replace-original hands over a repository on this computer, not a URL',
			);
		if (resolve(local).startsWith(`${resolve(root.path)}/`))
			throw new Error(`${local} is in the Epicenter folder already`);
		const status = await gitText(['status', '--porcelain'], { cwd: local });
		if (status.trim() !== '')
			throw new Error(
				`${local} has uncommitted changes; commit or stash them first, so the folder holds what Git holds`,
			);
	}
	const scratch = await mkdtemp(join(tmpdir(), 'epicenter-import-'));
	const mirror = join(scratch, 'mirror.git');
	const warnings: string[] = [];
	try {
		await gitText(['clone', '--mirror', '--quiet', local ?? source, mirror]);
		const branch =
			named ??
			(
				await gitText(['symbolic-ref', '--short', 'HEAD'], { cwd: mirror })
			).trim();
		const ref = `refs/heads/${branch}`;
		if (
			(await git(['rev-parse', '--verify', '--quiet', ref], { cwd: mirror }))
				.code !== 0
		)
			throw new Error(`${source} has no branch ${branch}`);
		const commits = (
			await gitText(['rev-list', '--first-parent', '--reverse', ref], {
				cwd: mirror,
			})
		)
			.split('\n')
			.filter(Boolean);
		if (commits.length === 0) throw new Error(`${branch} has no commits`);

		/** An LFS object's bytes: from the mirror, fetched when first asked, or a local source's store. */
		let fetched = false;
		const lfsObject = async (oid: string) => {
			const places = [
				lfsObjectPath(mirror, oid),
				...(local === null
					? []
					: [
							lfsObjectPath(join(local, '.git'), oid),
							lfsObjectPath(local, oid),
						]),
			];
			for (const place of places)
				if (existsSync(place)) return new Uint8Array(await readFile(place));
			if (!fetched) {
				fetched = true;
				const run = await git(['lfs', 'fetch', '--all', 'origin'], {
					cwd: mirror,
				});
				if (run.code !== 0)
					warnings.push(`git lfs fetch failed: ${run.stderr.trim()}`);
				if (existsSync(places[0] as string))
					return new Uint8Array(await readFile(places[0] as string));
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
					`${path}'s Git LFS object ${pointer.oid} could not be fetched; fetch it into ${source} (git lfs fetch --all), then import again`,
				);
			return object;
		};

		const made = await makeFolder(account, { importing: true });
		if (made.error !== null) throw new Error(made.error.message);
		const folder = made.data;
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
		let seq = 0;
		let pending: { commit: string; change: ImportedChange }[] = [];
		let pendingBytes = 0;

		const flush = async (): Promise<void> => {
			if (pending.length === 0) return;
			const batch = pending;
			pending = [];
			pendingBytes = 0;
			const sent = await repository.importChanges(
				batch.map(({ change }) => change),
			);
			if (sent.error !== null) throw new Error(sent.error.message);
			if ('cursor' in sent.data) {
				for (const { commit } of batch) seqOfCommit.set(commit, ++seq);
				return;
			}
			throw new Error(
				'refused' in sent.data
					? `the server refused ${sent.data.refused}: ${sent.data.reason}`
					: 'moved' in sent.data
						? `the folder moved during the import at ${sent.data.moved.map(({ path }) => path).join(', ')}`
						: 'the server lacks bytes it was sent',
			);
		};

		const folded = new Map<string, string>();
		const fold = (path: string) => path.normalize('NFC').toLowerCase();
		for (const [index, commit] of commits.entries()) {
			const parent = index === 0 ? null : (commits[index - 1] as string);
			const raw = readRaw(
				(
					await git(
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
				['log', '-1', '--format=%an%x00%ae%x00%at%x00%B', commit],
				{
					cwd: mirror,
				},
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
				mirror,
				writes.filter(({ status }) => status !== 'D').map(({ id }) => id),
			);
			const files: ImportedChange['files'] = [];
			for (const entry of writes) {
				const before = held.get(entry.path);
				if (entry.status === 'D' || /^0+$/.test(entry.id)) {
					if (before === undefined) continue;
					files.push({
						path: entry.path,
						expect: before.version as never,
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
				const bytes = await bytesOf(
					blobs.get(entry.id) as Uint8Array,
					entry.path,
				);
				const version = Buffer.from(
					await crypto.subtle.digest(
						'SHA-256',
						bytes as Uint8Array<ArrayBuffer>,
					),
				).toString('hex');
				if (before?.version === version) {
					held.set(entry.path, { version, blob: entry.id });
					continue;
				}
				files.push({
					path: entry.path,
					expect: (before?.version ?? null) as never,
					bytes,
				});
				held.set(entry.path, { version, blob: entry.id });
				folded.set(fold(entry.path), entry.path);
			}
			if (files.length === 0) {
				// Nothing a folder keeps changed: the commit maps to the change before it.
				await flush();
				seqOfCommit.set(commit, seq);
				continue;
			}
			// A commit too large for one request lands as several changes, each
			// with its author, time, and message; the commit maps to the last.
			let part: ImportedChange['files'] = [];
			let partBytes = 0;
			const push = async () => {
				if (pending.length > 0 && pendingBytes + partBytes > BATCH_BYTES)
					await flush();
				pending.push({
					commit,
					change: {
						author: `${author} <${email}>`,
						at: new Date(Number(at) * 1000),
						message,
						files: part,
					},
				});
				pendingBytes += partBytes;
				part = [];
				partBytes = 0;
				if (pending.length >= BATCH_CHANGES || pendingBytes >= BATCH_BYTES)
					await flush();
			};
			for (const file of files) {
				const size =
					'bytes' in file && file.bytes.byteLength <= INLINE_MAX
						? file.bytes.byteLength
						: 0;
				if (
					part.length > 0 &&
					(part.length >= PART_FILES || partBytes + size > BATCH_BYTES)
				)
					await push();
				part.push(file);
				partBytes += size;
			}
			await push();
		}
		await flush();

		// Each tag on the first-parent line becomes a mark on its change.
		const marks: string[] = [];
		const tags = await gitText(
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
			marks.push(tag);
		}
		const done = await repository.importDone();
		if (done.error !== null) throw new Error(done.error.message);

		// The files, written into a new, real directory in the Epicenter folder.
		const present = await root.list();
		if (present.error !== null) throw new Error(present.error.message);
		const wanted =
			name ??
			basename(local ?? source.replace(/\/+$/, '')).replace(/\.git$/, '');
		const made_ = await root.make(
			freeName(wanted || folder, [
				...present.data.folders.map(({ name }) => name),
				...present.data.unreadable.map(({ name }) => name),
			]),
		);
		if (made_.error !== null) throw new Error(made_.error.message);
		const directory = made_.data;
		const last = await readBlobs(
			mirror,
			[...held.values()].map(({ blob }) => blob),
		);
		const files: Record<string, string> = {};
		for (const [path, { version, blob }] of held) {
			const bytes = await bytesOf(last.get(blob) as Uint8Array, path);
			const put = await directory.store.put(path, bytes, null);
			if (put.error !== null) throw new Error(`${path}: ${put.error.message}`);
			files[path] = version;
		}
		const head = await repository.changes(null);
		if (head.error !== null) throw new Error(head.error.message);
		const records = await root.records();
		if (records.error !== null) throw new Error(records.error.message);
		const recorded = await records.data.write(
			{
				folder,
				name: directory.name,
				inode: directory.identity?.inode ?? '',
				birthtime: directory.identity?.birthtime ?? null,
				cursor: head.data.cursor,
				files: files as Record<string, never>,
			},
			null,
		);
		if (recorded.error !== null) throw new Error(recorded.error.message);

		let original: ImportReport['original'] = null;
		if (replaceOriginal && local !== null) {
			const aside = join(
				dirname(local),
				freeName(`${basename(local)} (before Epicenter)`, []),
			);
			if (await lstat(aside).catch(() => null))
				throw new Error(
					`${aside} is there already; move it, then hand over again`,
				);
			await rename(local, aside);
			await symlink(directory.path, local);
			original = { movedTo: aside, link: local };
		}
		return {
			folder,
			path: directory.path,
			branch,
			commits: commits.length,
			changes: seq,
			marks,
			warnings,
			original,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
