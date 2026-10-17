/**
 * Discovery publication through the ordinary file boundary (ADR-0517): the
 * folder's definition, at `epicenter.json`, as JSON a tool can read without
 * running anything. A handle publishes it just before its first write, so a
 * folder nobody writes to is never touched, and a folder written to says
 * which definition last wrote it. A file that already holds the definition's
 * bytes is left as it is.
 *
 * With the definition, the handle makes the root `.gitignore` name every
 * `local` pattern `epicenter.json` then lists, its definition's and any a
 * Sync brought from another device, so files that stay on the machine that
 * wrote them never enter a commit, plain `git add -A` included. It only adds
 * lines: a person's own lines stay as they are.
 *
 * Both go through the host's storage rather than the handle's writes, so a
 * publication never waits on itself: the definition as a put guarded by the
 * hash it read, which replaces the file, and `.gitignore` through the one
 * write (`writeFile`), which merges with it.
 */
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { FolderStorage } from './boundary.js';
import { formatDefinition, localPatterns } from './declaration.js';
import type { Definition } from './definition.js';
import { WriteError } from './errors.js';
import { hashBytes } from './hash.js';
import { sameContent } from './merge-file.js';
import { DEFINITION_PATH } from './paths.js';
import {
	confirmedPut,
	WRITE_ATTEMPTS,
	writeFailure,
	writeFile,
} from './write.js';

const encoder = new TextEncoder();

const log = createLogger('folder/definition');
/** What a publication reads and writes: the storage port's read and put, not a handle's writes. */
type Publisher = Pick<FolderStorage, 'read' | 'put'>;
/** The folder's root `.gitignore`, where `local` patterns are written. */
const GITIGNORE_PATH = '.gitignore';
const PublicationError = defineErrors({
	DefinitionPublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Publication of ${DEFINITION_PATH} did not confirm a complete save.`,
		path: DEFINITION_PATH,
		cause,
	}),
	LocalPatternsUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Adding the folder's local patterns to ${GITIGNORE_PATH} did not confirm a complete save.`,
		path: GITIGNORE_PATH,
		cause,
	}),
});

/**
 * Await one publication of `prepared` at `epicenter.json`: the formatted
 * definition put over the file it read, guarded by that file's hash, so the
 * definition replaces what it read whole, keys only the file held included.
 * The one exception is `local`, the sorted union of the file's patterns and
 * the definition's, so a pattern a Sync brought from another device is kept
 * (ADR-0577) until templates replace `local`. A file already holding the
 * result is left as it is. Another writer landing between the read and the
 * put makes the put stale, and the publication reads that file and replaces
 * it instead, at most `WRITE_ATTEMPTS` times; it never merges with it. A
 * failure is logged and never refuses the write it precedes.
 *
 * Answers the `local` patterns the file lists once published, for
 * `.gitignore`, or the definition's own when the publication failed.
 */
export async function publishDefinition(
	prepared: Definition,
	storage: Publisher,
): Promise<readonly string[]> {
	const own = prepared.local ?? [];
	let failure: unknown = WriteError.KeptChanging({
		path: DEFINITION_PATH,
		attempts: WRITE_ATTEMPTS,
	}).error;
	try {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const read = await storage.read(DEFINITION_PATH);
			if (read.error !== null && read.error.name !== 'NotFound') {
				failure = writeFailure(DEFINITION_PATH, read.error);
				break;
			}
			const current = read.error === null ? read.data : null;
			const listed = localPatterns(current?.bytes ?? null) ?? [];
			const local = listed.every((pattern) => own.includes(pattern))
				? own
				: [...new Set([...own, ...listed])].sort();
			const bytes = encoder.encode(
				formatDefinition(local === own ? prepared : { ...prepared, local }),
			);
			if (current !== null && sameContent(bytes, current.bytes)) return local;
			const { data: put, error } = await confirmedPut(
				storage,
				DEFINITION_PATH,
				bytes,
				current?.sha256 ?? null,
				await hashBytes(bytes),
			);
			if (error !== null) {
				failure = writeFailure(DEFINITION_PATH, error);
				break;
			}
			if (put === 'landed') return local;
		}
	} catch (cause) {
		// A thrown write can also have landed. Retain the cause without claiming
		// the destination is missing, unchanged, or successfully published.
		failure = cause;
	}
	log.error(
		PublicationError.DefinitionPublicationUnconfirmed({ cause: failure }),
	);
	return own;
}

/**
 * Await one attempt to make the root `.gitignore` name each `local`
 * pattern, skipped when every pattern is already one of its lines. A missing
 * file is created holding the patterns. A present one gains the missing
 * patterns as lines at its end; nothing in it is reordered, rewritten, or
 * removed, so a person's own lines stay. The addition is written with the
 * one write, from the file as it was read, so a line another writer adds
 * meanwhile stays too; the file is read again until it names every pattern,
 * since a line another writer removed meanwhile stays removed in that merge.
 * A failure is logged and never refuses the write it precedes.
 */
export async function publishLocalPatterns(
	local: readonly string[],
	storage: Publisher,
): Promise<void> {
	if (local.length === 0) return;
	let failure: unknown = 'another writer kept removing the patterns';
	try {
		// Read again after each write: the merge keeps a line another writer
		// removed meanwhile, so a landed write is not yet every pattern.
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const read = await storage.read(GITIGNORE_PATH);
			if (read.error !== null && read.error.name !== 'NotFound') {
				failure = writeFailure(GITIGNORE_PATH, read.error);
				break;
			}
			const current = read.error === null ? read.data.bytes : null;
			const text = current === null ? '' : new TextDecoder().decode(current);
			const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
			const missing = local.filter((pattern) => !lines.has(pattern));
			if (missing.length === 0) return;
			const separator = text === '' || text.endsWith('\n') ? '' : '\n';
			const { error } = await writeFile(
				storage,
				GITIGNORE_PATH,
				current,
				`${text}${separator}${missing.join('\n')}\n`,
				{ joining: true },
			);
			if (error !== null) {
				failure = error;
				break;
			}
		}
	} catch (cause) {
		failure = cause;
	}
	log.error(PublicationError.LocalPatternsUnconfirmed({ cause: failure }));
}
