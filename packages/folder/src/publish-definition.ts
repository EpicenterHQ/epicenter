/**
 * Discovery publication through the ordinary file boundary (ADR-0517): the
 * folder's declaration, at `epicenter.json`, as JSON a tool can read without
 * running anything. A handle publishes it just before its first write, so a
 * folder nobody writes to is never touched, and a folder written to says
 * which definition last wrote it. A file that already holds the declaration's
 * bytes is left as it is.
 *
 * With the declaration, the handle makes the root `.gitignore` name the
 * definition's `local` patterns, so files that stay on the machine that
 * wrote them never enter a commit. It only adds lines: a person's own lines
 * stay as they are.
 */
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { FileRead, FolderStorage } from './boundary.js';
import { formatDeclaration } from './declaration.js';
import type { FolderDefinition } from './definition.js';
import { hashBytes } from './hash.js';
import { localPatterns } from './merge-file.js';
import { DECLARATION_PATH } from './paths.js';
import { confirmedPut } from './write.js';

const log = createLogger('folder/definition');
const encoder = new TextEncoder();
/** What a publication reads and writes: the storage port's read and put, not a handle's writes. */
type Publisher = Pick<FolderStorage, 'read' | 'put'>;
/** The folder's root `.gitignore`, where `local` patterns are written. */
const GITIGNORE_PATH = '.gitignore';
const PublicationError = defineErrors({
	DefinitionPublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Publication of ${DECLARATION_PATH} did not confirm a complete save.`,
		path: DECLARATION_PATH,
		cause,
	}),
	LocalPatternsUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Adding the folder's local patterns to ${GITIGNORE_PATH} did not confirm a complete save.`,
		path: GITIGNORE_PATH,
		cause,
	}),
});

/**
 * `prepared` with `local` also listing what the file there lists, sorted, so
 * a pattern a Sync brought from another device (ADR-0576) is never dropped
 * by this definition's publication. A file whose `local` does not read adds
 * nothing.
 */
function keepingLocal(
	prepared: FolderDefinition,
	declared: readonly string[] | undefined,
): FolderDefinition {
	const local = [
		...new Set([...(prepared.local ?? []), ...(declared ?? [])]),
	].sort();
	return local.length === 0 ? prepared : { ...prepared, local };
}

/**
 * Put `bytes` at `path` only while it holds what was read (`current`, or no
 * file), never merged: `'stale'` when another writer landed first, and
 * nothing changed.
 */
async function putOver(
	storage: Publisher,
	path: string,
	current: FileRead | null,
	bytes: Uint8Array,
) {
	return confirmedPut(
		storage,
		path,
		bytes,
		current?.sha256 ?? null,
		await hashBytes(bytes),
	);
}

/** Why a publication gave up after reading again: another writer kept landing first. */
const KEPT_CHANGING = 'another writer changed the file on every attempt';

/**
 * Await one publication, skipped when the file already holds the
 * declaration's bytes. `epicenter.json` is never merged (ADR-0551) but for
 * `local`, which keeps every pattern the file already lists: the declaration
 * is put over the file as read, or where none is, and read once more when
 * another writer landed first. A failure is logged and never refuses the
 * write it precedes.
 */
export async function publishDefinition(
	prepared: FolderDefinition,
	storage: Publisher,
): Promise<void> {
	let failure: unknown = KEPT_CHANGING;
	try {
		for (let reads = 0; reads < 2; reads++) {
			const read = await storage.read(DECLARATION_PATH);
			if (read.error !== null && read.error.name !== 'NotFound') {
				failure = read.error;
				break;
			}
			const current = read.error === null ? read.data : null;
			const declaration = encoder.encode(
				formatDeclaration(
					keepingLocal(
						prepared,
						current === null ? undefined : localPatterns(current.bytes),
					),
				),
			);
			if (current !== null && current.sha256 === (await hashBytes(declaration)))
				return;
			const { data: put, error } = await putOver(
				storage,
				DECLARATION_PATH,
				current,
				declaration,
			);
			if (error !== null) {
				failure = error;
				break;
			}
			if (put === 'landed') return;
		}
	} catch (cause) {
		// A thrown write can also have landed. Retain the cause without claiming
		// the destination is missing, unchanged, or successfully published.
		failure = cause;
	}
	log.error(
		PublicationError.DefinitionPublicationUnconfirmed({ cause: failure }),
	);
}

/**
 * Await one attempt to make the root `.gitignore` name each `local`
 * pattern, skipped when every pattern is already one of its lines. A missing
 * file is created holding the patterns. A present one gains the missing
 * patterns as lines at its end; nothing in it is reordered, rewritten, or
 * removed, so a person's own lines stay. The put never merges: when another
 * writer landed first, the file is read once more. A failure is logged and
 * never refuses the write it precedes.
 */
export async function publishLocalPatterns(
	local: readonly string[],
	storage: Publisher,
): Promise<void> {
	if (local.length === 0) return;
	let failure: unknown = KEPT_CHANGING;
	try {
		for (let reads = 0; reads < 2; reads++) {
			const read = await storage.read(GITIGNORE_PATH);
			if (read.error !== null && read.error.name !== 'NotFound') {
				failure = read.error;
				break;
			}
			const current = read.error === null ? read.data : null;
			const text =
				current === null ? '' : new TextDecoder().decode(current.bytes);
			const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
			const missing = local.filter((pattern) => !lines.has(pattern));
			if (missing.length === 0) return;
			const separator = text === '' || text.endsWith('\n') ? '' : '\n';
			const next = `${text}${separator}${missing.join('\n')}\n`;
			const { data: put, error } = await putOver(
				storage,
				GITIGNORE_PATH,
				current,
				encoder.encode(next),
			);
			if (error !== null) {
				failure = error;
				break;
			}
			if (put === 'landed') return;
		}
	} catch (cause) {
		failure = cause;
	}
	log.error(PublicationError.LocalPatternsUnconfirmed({ cause: failure }));
}

/**
 * `storage`, publishing the declaration and the `local` patterns once before
 * the first change this handle makes. Reads publish nothing. The
 * publications' own writes go to `storage` directly, and their failures are
 * logged without refusing the write.
 */
export function declaring(
	storage: FolderStorage,
	prepared: FolderDefinition,
): FolderStorage {
	let published: Promise<void> | undefined;
	const first = () => {
		published ??= publishDefinition(prepared, storage).then(() =>
			publishLocalPatterns(prepared.local ?? [], storage),
		);
		return published;
	};
	return {
		...storage,
		async put(path, bytes, ifMatch) {
			await first();
			return storage.put(path, bytes, ifMatch);
		},
		// Published before the lock is taken: publishing writes through it.
		async lock(work) {
			await first();
			return storage.lock(work);
		},
		async mkdir(path) {
			await first();
			return storage.mkdir(path);
		},
	};
}
