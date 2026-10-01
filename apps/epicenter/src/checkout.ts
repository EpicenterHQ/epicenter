/**
 * The host's half of the `~/Epicenter` working copy (ADR-0337).
 *
 * The application renders, diffs, and decides. This writes the files it is
 * handed and reads back the files it holds, and interprets neither: nothing
 * here parses frontmatter, opens a store, decodes a CRDT update, or holds a
 * definition.
 *
 * ADR-0271 refused a host that reads the folder at all. That refusal served
 * the one-way rule and goes with it; what stays refused is a host that
 * INTERPRETS a file, which is a narrower promise and the one worth keeping.
 *
 * What this module owes.
 *
 * **A path cannot escape the folder.** Checked twice, because the two checks
 * promise different things. Containment is the host's own promise about its
 * own root and holds whatever the application sends. The file grammar is the
 * application's shape, and refusing anything else is what keeps the folder to
 * what a checkout produces.
 *
 * **A file is never half-written.** Something else reads this folder, and an
 * agent that reads a note mid-write sees a truncated one. Every write lands in
 * a temporary file and is renamed into place, which is atomic within a
 * filesystem.
 *
 * **A checkout that stops halfway reads as dirty, not as clean.** The manifest
 * is written last, so an interrupted pull leaves the previous one describing a
 * folder that no longer matches it, and the next pull says so.
 *
 * **What a checkout does not name is not the host's to keep.** A checkout is
 * complete by definition, so a file the application did not send no longer
 * exists. That is filtered to the four shapes a checkout produces, which
 * includes the `AGENTS.md` it generates; a person's own `README.md` and the
 * `drafts/` they keep are not among them and are never written, read back, or
 * removed here.
 *
 * **One request at a time, per folder.** A read and a write are chained on the
 * same promise, so a `GET` never catches a folder half-replaced and two writes
 * never interleave their sweeps. It is a chain in this process rather than a
 * lock on disk: the host is the one process that owns `~/Epicenter`
 * (`tauri-plugin-single-instance`), so a lock file bought exclusion against
 * nobody and could outlive the process that took it.
 *
 * **A write says which folder it was written against.** A read hands back a
 * digest of the bytes it produced, a write requires it back, and the compare
 * happens in the same chain slot as the sweep. That is what makes the approval
 * a person gave describe the folder the write lands on, and it is still bytes:
 * nothing here reads what the digest is a digest of.
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
// One import, and it is the entry point that holds no CRDT: this module writes
// and reads files and interprets none of them, so nothing here may reach the
// half of the checkout that opens a store.
import {
	AGENTS_PATH,
	type CheckoutFile,
	checkoutLine,
	MANIFEST_PATH,
	parseCheckout,
	parseRowPath,
} from '@epicenter/app/artifact/format';
import { isAppId } from '@epicenter/constants/app-data';

/**
 * The folder is not the one the write was prepared against.
 *
 * A file landed, an agent moved a note, or a second window pulled, between the
 * read a person approved and this write. The store is untouched and the repair
 * is to read the folder again, which is why this is the host's only refusal
 * that is not a filesystem failure.
 */
export class CheckoutPreconditionFailedError extends Error {
	override readonly name = 'CheckoutPreconditionFailed';
}

/**
 * What is in flight for each folder, so the next request chains onto it.
 *
 * Keyed by absolute folder, and the entry is dropped when it is the tail, so
 * this does not grow with the number of folders a session touches. Every
 * public verb below runs inside `serialize`, reads and writes alike: a read
 * that ran beside a write would hand back a folder half-swept, and the digest
 * it returned would describe a state that never existed.
 */
const inFlight = new Map<string, Promise<unknown>>();

function serialize<T>(folder: string, task: () => Promise<T>): Promise<T> {
	const previous = inFlight.get(folder) ?? Promise.resolve();
	const running = previous.then(task);
	// What the next request chains onto never rejects, so one request failing
	// does not poison the queue behind it. The caller still gets `running`,
	// which rejects with what the task threw.
	const settled = running.then(
		() => undefined,
		() => undefined,
	);
	inFlight.set(folder, settled);
	void settled.then(() => {
		if (inFlight.get(folder) === settled) inFlight.delete(folder);
	});
	return running;
}

/**
 * The folder's identity, as a strong ETag over the bytes a read produced.
 *
 * SHA-256, quoted, and it is not a security claim: what it answers is "is this
 * the folder the write was prepared against". Digesting the NDJSON rather than
 * the directory is what keeps this side free of meaning, and it covers exactly
 * what a checkout is responsible for, so a person's own `README.md` changing
 * does not invalidate a pull they are reading.
 */
function checkoutEtag(ndjson: string): string {
	return `"${createHash('sha256').update(ndjson, 'utf8').digest('hex')}"`;
}

/**
 * The folder a data id's files live in, or `undefined` when the request does
 * not name one.
 *
 * One segment under the root, and the segment is the data id (ADR-0337). The
 * `local`/`account` segment below it went with the device store: there is one
 * store per data id, so there is one folder, which is what amends ADR-0315's
 * layout.
 */
export function checkoutFolderPath({
	dataId,
	root,
}: {
	dataId: string;
	root: string;
}): string | undefined {
	if (!isAppId(dataId)) return undefined;
	return join(root, dataId);
}

/**
 * Whether a path is one a checkout is responsible for.
 *
 * Four shapes and no others: a row file, `kv.json`, the manifest, and the
 * `AGENTS.md` a pull generates (ADR-0337, ADR-0330). That last one is the
 * store's file rather than a person's, which is why it is swept like the rest
 * and why its own first line says every pull replaces it.
 *
 * Everything else in the folder is theirs. A `README.md`, a `drafts/` they
 * keep, a `.git`: none is written, read back, or removed here.
 */
function isCheckoutPath(path: string): boolean {
	return (
		path === 'kv.json' ||
		path === MANIFEST_PATH ||
		path === AGENTS_PATH ||
		parseRowPath(path) !== undefined
	);
}

/**
 * The absolute path one file lives at, or `undefined`.
 *
 * Containment first, and it is not decoration. `parseRowPath` splits on `/`
 * and checks the extension; it does not enforce the address grammar, so
 * `../x.md` parses as a table named `..`. A grammar check alone would have
 * admitted it. Resolving and comparing against the folder is what actually
 * promises the file lands inside.
 */
function fileInFolder(folder: string, path: string): string | undefined {
	if (!isCheckoutPath(path)) return undefined;
	const target = resolve(folder, path);
	if (target !== folder && !target.startsWith(folder + sep)) return undefined;
	return target;
}

/** Write one file, atomically, staging beside the target so the rename is one. */
async function writeCheckoutFile(
	absolutePath: string,
	contents: string,
): Promise<void> {
	// Skip a write whose bytes already match. Not a speed optimization: a
	// rename replaces the inode, so rewriting an unchanged file makes Time
	// Machine, rclone, and Spotlight see the whole vault as new every time a
	// checkout lands. A read mutates nothing and costs far less than the churn.
	const existing = await readFile(absolutePath, 'utf8').catch(() => undefined);
	if (existing === contents) return;

	await mkdir(dirname(absolutePath), { recursive: true });
	const staged = `${absolutePath}.epicenter-tmp`;
	try {
		await writeFile(staged, contents, 'utf8');
		await rename(staged, absolutePath);
	} catch (cause) {
		await rm(staged, { force: true }).catch(() => undefined);
		throw cause;
	}
}

/**
 * Every path this folder holds that a checkout is responsible for.
 *
 * A folder that is not there yet lists as empty rather than failing: a place
 * that has never been pulled has no stale files by definition.
 */
async function listCheckoutFiles(absoluteFolder: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(absoluteFolder, {
			recursive: true,
			withFileTypes: true,
		});
	} catch {
		return [];
	}
	return (
		entries
			.filter((entry) => entry.isFile())
			.map((entry) =>
				relative(absoluteFolder, join(entry.parentPath, entry.name)).split(sep),
			)
			.map((segments) => segments.join('/'))
			.filter(isCheckoutPath)
			// Sorted, so the digest below is a function of what the folder holds and
			// not of the order a filesystem happened to walk it. The application
			// sorts its plan for the same reason: a folder read twice has to be the
			// same folder, or a write prepared against one reading is refused
			// against an identical one.
			.sort()
	);
}

/**
 * Replace this folder's checkout with the one on the wire (`pull`'s half).
 *
 * Stale files first, then every file, then the manifest last. **The order is
 * the recovery.** A write interrupted anywhere leaves the manifest describing
 * the checkout BEFORE this one, so the next `pull` compares the half-written
 * folder against a base it does not match, calls it dirty, and shows a person
 * what is there. A manifest written first would describe a folder that does
 * not exist yet and read as clean.
 *
 * There is no staged copy of the whole folder, and there was one: it existed
 * so a reader never saw the folder half-replaced, back when something read it
 * continuously. Nothing does now, a pull is a moment a person chose, and the
 * copy meant a person's own `.git` was duplicated to new inodes on every pull,
 * which is the churn the per-file byte comparison below exists to avoid.
 *
 * Nothing outside `isCheckoutPath` is touched, in either direction: what a
 * person put in this folder survives a pull, and so does the `AGENTS.md` a
 * pull itself wrote.
 */
export function writeCheckout(
	absoluteFolder: string,
	ndjson: string,
	ifMatch: string,
): Promise<void> {
	return serialize(absoluteFolder, async () => {
		// Inside the chain, so the folder this compares cannot move before the
		// sweep below reaches it. A check in the route would be a check against
		// a folder some other request is still writing.
		if (checkoutEtag(await collectCheckout(absoluteFolder)) !== ifMatch) {
			throw new CheckoutPreconditionFailedError(
				`The folder changed since it was read: ${absoluteFolder}`,
			);
		}
		const files: CheckoutFile[] = [];
		for (const file of parseCheckout(ndjson)) {
			if (fileInFolder(absoluteFolder, file.path) !== undefined) {
				files.push(file);
			}
		}
		const named = new Set(files.map((file) => file.path));
		for (const path of await listCheckoutFiles(absoluteFolder)) {
			if (!named.has(path))
				await rm(join(absoluteFolder, path), { force: true });
		}
		// The manifest last, whatever order it arrived in.
		for (const file of [...files].sort(manifestLast)) {
			const target = fileInFolder(absoluteFolder, file.path);
			if (target !== undefined) await writeCheckoutFile(target, file.contents);
		}
	});
}

function manifestLast(left: CheckoutFile, right: CheckoutFile): number {
	return (
		Number(left.path === MANIFEST_PATH) - Number(right.path === MANIFEST_PATH)
	);
}

/**
 * Hand back every file this folder holds that a checkout is responsible for
 * (`push`'s half, and what `pull` reads to know the folder is clean).
 *
 * Contents, not names, and that is the whole of the change ADR-0337 makes to
 * the host: the application owns the diff, so it has to see what is on disk.
 * The host still interprets none of it.
 *
 * That includes the `AGENTS.md` the application generated, which rides back
 * unread: the rule here is "everything a checkout produces", and one exception
 * would be a second rule to keep in step with the other side.
 */
export function readCheckout(
	absoluteFolder: string,
): Promise<{ ndjson: string; etag: string }> {
	return serialize(absoluteFolder, async () => {
		const ndjson = await collectCheckout(absoluteFolder);
		return { ndjson, etag: checkoutEtag(ndjson) };
	});
}

/**
 * The read itself, without the chain, for the two callers already inside one.
 */
async function collectCheckout(absoluteFolder: string): Promise<string> {
	const lines: string[] = [];
	for (const path of await listCheckoutFiles(absoluteFolder)) {
		const contents = await readFile(join(absoluteFolder, path), 'utf8').catch(
			() => undefined,
		);
		// A file listed and then unreadable is one somebody removed between the
		// two calls. Omitting it says the folder does not have it, which by then
		// is true. The digest changes with it, so a write prepared against the
		// reading that included it is refused rather than silently deleting the
		// row whose file went missing on the way out.
		if (contents !== undefined) lines.push(checkoutLine({ path, contents }));
	}
	return lines.join('');
}
