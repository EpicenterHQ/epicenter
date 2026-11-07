/**
 * A folder's history leaving Epicenter as a Git repository (ADR-0824,
 * ADR-0826, ADR-0827), written by `git fast-import` in projection v2:
 * `epicenter export --git <dir>`. It drives `git` from Bun, so it is
 * `@epicenter/folder/node`'s.
 *
 * Projection v2, deterministic, so the same log always makes the same
 * commit ids:
 * - one commit per change on `main`, its parent the previous change's;
 * - author and committer the change's author as stored, at its time in
 *   whole seconds, `+0000`;
 * - the message an imported commit kept, or one naming what the change
 *   wrote, then the trailers `Epicenter-Change: <seq>`,
 *   `Epicenter-Folder: <id>`, and `Epicenter-Digest: <digest>`;
 * - the text the platform reads, a note (`.md`, at any depth) and the
 *   folder's `epicenter.json`, as a blob of its bytes; every other file as
 *   a Git LFS pointer whose oid is its version, with its bytes written to
 *   `.git/lfs/objects`; a version whose bytes were purged keeps its pointer
 *   and is listed in the report;
 * - `.gitattributes`, written by the export alone in the first commit, and
 *   any `.gitattributes` the folder holds left out;
 * - each mark as a lightweight tag at its change.
 *
 * Projection v1 wrote `epicenter.json` as an LFS pointer; its
 * `.gitattributes` differ, so a v1 export is never continued in v2.
 *
 * It is incremental: fast-import's marks (`.git/epicenter/marks`, mark
 * `:<seq>` for change `seq`) and the tip's `Epicenter-Change` trailer say
 * where the last run stopped, and a run writes only the changes after it.
 * A new directory is checked out at `main`; an existing checkout moves to
 * the new `main` only when it held the old one unchanged.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONTRACT_PATH, isNotePath } from '@epicenter/definition/contract';
import { Ok, type Result } from 'wellcrafted/result';
import type { FolderRepository, LoggedChange } from '../remote/repository.js';
import {
	GitError,
	gitText as hostText,
	lfsObjectPath,
	lfsPointer,
} from './host.js';
import { git, gitHost } from './node.js';

const gitText = (args: readonly string[], options: { cwd?: string } = {}) =>
	hostText(gitHost, args, options);

/** What an export reads of a folder: its log, bytes by version, and marks. */
export type History = Pick<FolderRepository, 'log' | 'blobs' | 'marks'>;

/** What one export wrote. */
export type ExportReport = {
	dir: string;
	folder: string;
	/** The last change exported before this run (0: none). */
	from: number;
	/** The last change exported now. */
	to: number;
	/** The tags written, one per mark. */
	tags: string[];
	/** Versions whose bytes were purged: each kept as its pointer. */
	purged: { seq: number; path: string; version: string }[];
	/** Paths left out, and why. */
	skipped: { seq: number; path: string; reason: string }[];
	/** Whether the checkout was made, moved to the new `main`, or left as it was. */
	checkout: 'made' | 'moved' | 'left';
};

/**
 * The attributes projection v2 writes: notes and the folder's
 * `epicenter.json` are Git's, every other file Git LFS's.
 */
export const EXPORT_ATTRIBUTES = `* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff !merge text
/${CONTRACT_PATH} !filter !diff !merge text
.gitattributes !filter !diff !merge text
`;

/** Whether the export writes `path` as a blob of its bytes: text the platform reads. */
export const isPlainPath = (path: string) =>
	isNotePath(path) || path === CONTRACT_PATH;

const PAGE = 200;
const NOTE_CHUNK = 200;
const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

/** `Name <email>` as Git's ident takes it: no angle brackets or line breaks in either part. */
function ident(author: string) {
	const clean = (value: string) => value.replace(/[<>\n]/g, '').trim();
	const found = /^(.*?)\s*<([^<>]*)>\s*$/.exec(author);
	return found === null
		? `${clean(author)} <>`
		: `${clean(found[1] ?? '')} <${clean(found[2] ?? '')}>`;
}

/** A path as fast-import reads it: quoted, C-style, when it could be misread. */
function quoted(path: string) {
	if (!/^"|[\n\\"]/.test(path)) return path;
	return `"${path.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')}"`;
}

/** The message of change `change` of folder `folder`. */
export function messageOf(folder: string, change: LoggedChange): string {
	const [only] = change.files;
	const subject =
		change.message?.replace(/\s+$/, '') ||
		(change.files.length === 1 && only !== undefined
			? `${only.version === null ? 'Delete' : 'Write'} ${only.path}`
			: `Write ${change.files.length} files`);
	return `${subject}\n\nEpicenter-Change: ${change.seq}\nEpicenter-Folder: ${folder}\nEpicenter-Digest: ${change.digest}\n`;
}

/** The `Epicenter-Change` and `Epicenter-Folder` trailers of a commit message. */
function trailers(message: string) {
	const seq = /^Epicenter-Change: (\d+)$/m.exec(message)?.[1];
	const folder = /^Epicenter-Folder: (\S+)$/m.exec(message)?.[1];
	return {
		seq: seq === undefined ? null : Number(seq),
		folder: folder ?? null,
	};
}

/** Change seq to commit id, as fast-import's marks file holds them. */
async function readMarks(path: string): Promise<Map<number, string>> {
	const marks = new Map<number, string>();
	if (!existsSync(path)) return marks;
	for (const line of (await readFile(path, 'utf8')).split('\n')) {
		const found = /^:(\d+) ([0-9a-f]{40,64})$/.exec(line);
		if (found) marks.set(Number(found[1]), found[2] as string);
	}
	return marks;
}

/**
 * Write the history of folder `folder` (as `history` reads it) into the
 * Git repository at `dir`, made when absent: every change after the last
 * one exported there.
 */
export async function exportGit(options: {
	folder: string;
	history: History;
	dir: string;
}): Promise<Result<ExportReport, GitError>> {
	try {
		return Ok(await runExport(options));
	} catch (cause) {
		return GitError.Failed({ cause });
	}
}

async function runExport({
	folder,
	history,
	dir,
}: {
	folder: string;
	history: History;
	dir: string;
}): Promise<ExportReport> {
	const gitDir = join(dir, '.git');
	if (!existsSync(gitDir)) {
		await mkdir(dir, { recursive: true });
		await gitText(['init', '--quiet', '--initial-branch=main', dir]);
	}
	const marksPath = join(gitDir, 'epicenter', 'marks');
	await mkdir(dirname(marksPath), { recursive: true });
	const tip = await git(
		['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
		{ cwd: dir },
	);
	const old =
		tip.code === 0 ? new TextDecoder().decode(tip.stdout).trim() : null;
	let from = 0;
	if (old !== null) {
		const found = trailers(
			await gitText(['log', '-1', '--format=%B', old], { cwd: dir }),
		);
		if (found.seq === null)
			throw new Error(
				`${dir}'s main holds commits no Epicenter export wrote; export into a new directory`,
			);
		if (found.folder !== folder)
			throw new Error(
				`${dir} holds the export of folder ${found.folder}, not ${folder}`,
			);
		const attributes = await git(['show', `${old}:.gitattributes`], {
			cwd: dir,
		});
		if (new TextDecoder().decode(attributes.stdout) !== EXPORT_ATTRIBUTES)
			throw new Error(
				`${dir} holds an export in an older projection; export into a new directory`,
			);
		from = found.seq;
		const marks = await readMarks(marksPath);
		if (marks.get(from) !== old) {
			// The marks file went missing or stale: read every exported commit's change again.
			const log = await gitText(['log', '--format=%H%x00%B%x1e', old], {
				cwd: dir,
			});
			const lines: string[] = [];
			for (const entry of log.split('\x1e')) {
				const [id, message = ''] = entry.trim().split('\0');
				const seq = trailers(message).seq;
				if (id && seq !== null) lines.push(`:${seq} ${id}`);
			}
			await writeFile(marksPath, `${lines.join('\n')}\n`);
		}
	}

	const child = Bun.spawn(
		[
			'git',
			'fast-import',
			'--quiet',
			'--done',
			`--import-marks-if-exists=${marksPath}`,
			`--export-marks=${marksPath}`,
		],
		{ cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
	);
	const send = (bytes: Uint8Array | string) => {
		child.stdin.write(typeof bytes === 'string' ? text(bytes) : bytes);
	};
	const data = (bytes: Uint8Array) => {
		send(`data ${bytes.byteLength}\n`);
		send(bytes);
		send('\n');
	};
	const report: ExportReport = {
		dir,
		folder,
		from,
		to: from,
		tags: [],
		purged: [],
		skipped: [],
		checkout: 'left',
	};
	let failure: unknown = null;
	try {
		send('feature done\n');
		let after = from;
		for (;;) {
			const page = await history.log({ after, limit: PAGE });
			if (page.error !== null) throw new Error(page.error.message);
			if (page.data.length === 0) break;
			// The plain files' bytes, read together; each other file's, one at a time.
			const notes = [
				...new Set(
					page.data.flatMap(({ files }) =>
						files.flatMap(({ path, version }) =>
							version !== null && isPlainPath(path) ? [version] : [],
						),
					),
				),
			];
			const noteBytes = new Map<string, Uint8Array | null>();
			for (let start = 0; start < notes.length; start += NOTE_CHUNK) {
				const chunk = notes.slice(start, start + NOTE_CHUNK);
				const read = await history.blobs(chunk as never);
				if (read.error !== null) throw new Error(read.error.message);
				for (const [index, version] of chunk.entries())
					noteBytes.set(version, read.data[index] ?? null);
			}
			for (const change of page.data) {
				const when = `${Math.floor(Date.parse(change.at) / 1000)} +0000`;
				const who = ident(change.author);
				send(`commit refs/heads/main\nmark :${change.seq}\n`);
				send(`author ${who} ${when}\ncommitter ${who} ${when}\n`);
				data(text(messageOf(folder, change)));
				if (change.seq > 1 && change.seq - 1 === report.to)
					send(`from :${change.seq - 1}\n`);
				if (change.seq === 1) {
					send('M 100644 inline .gitattributes\n');
					data(text(EXPORT_ATTRIBUTES));
				}
				for (const { path, version, size } of change.files) {
					if (path === '.gitattributes') {
						report.skipped.push({
							seq: change.seq,
							path,
							reason: 'the export writes its own .gitattributes',
						});
						continue;
					}
					if (version === null) {
						send(`D ${quoted(path)}\n`);
						continue;
					}
					let bytes: Uint8Array | null = null;
					if (isPlainPath(path)) bytes = noteBytes.get(version) ?? null;
					else {
						const object = lfsObjectPath(gitDir, version);
						if (!existsSync(object)) {
							const read = await history.blobs([version] as never);
							if (read.error !== null) throw new Error(read.error.message);
							const got = read.data[0] ?? null;
							if (got !== null) {
								await mkdir(dirname(object), { recursive: true });
								await writeFile(object, got);
							} else report.purged.push({ seq: change.seq, path, version });
						}
						bytes = text(lfsPointer(version, size ?? 0));
					}
					if (bytes === null) {
						// A plain file whose bytes were purged: its pointer, as any other file's.

						report.purged.push({ seq: change.seq, path, version });
						bytes = text(lfsPointer(version, size ?? 0));
					}
					send(`M 100644 inline ${quoted(path)}\n`);
					data(bytes);
				}
				send('\n');
				report.to = change.seq;
			}
			after = report.to;
		}
		const marks = await history.marks();
		if (marks.error !== null) throw new Error(marks.error.message);
		for (const { name, seq } of marks.data) {
			if (seq > report.to) continue;
			send(`reset refs/tags/${name}\nfrom :${seq}\n\n`);
			report.tags.push(name);
		}
		send('done\n');
	} catch (cause) {
		failure = cause;
	} finally {
		child.stdin.end();
	}
	const [stderr, code] = await Promise.all([
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (failure !== null) throw failure;
	if (code !== 0)
		throw new Error(`git fast-import failed (${code}): ${stderr.trim()}`);
	if (report.to === 0) return report;

	if (old === null) {
		await gitText(['reset', '--quiet', '--hard', 'main'], { cwd: dir });
		report.checkout = 'made';
	} else if (report.to !== from) {
		// Move a checkout that held the old main unchanged; leave any other as it is.
		const head = await git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: dir });
		const onMain =
			new TextDecoder().decode(head.stdout).trim() === 'refs/heads/main';
		const clean =
			(await git(['diff-index', '--quiet', old, '--'], { cwd: dir })).code ===
			0;
		if (onMain && clean) {
			const moved = await git(['read-tree', '-u', '-m', old, 'main'], {
				cwd: dir,
			});
			if (moved.code === 0) report.checkout = 'moved';
		}
	}
	return report;
}
