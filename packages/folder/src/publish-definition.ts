/**
 * Discovery publication through the ordinary file boundary (ADR-0517): each
 * of the definition's tables at `<table>/.epicenter.json`, its schema, as
 * JSON a tool can read without running anything. A handle publishes them
 * just before its first write, so a folder nobody writes to is never
 * touched, and a folder written to says which definition last wrote each
 * of its tables. A file that already holds its table's bytes is left as it
 * is. A table directory the definition does not name is left as it is too:
 * a publication writes only its own tables' schemas.
 *
 * With the schemas, the handle makes the root `.gitignore` name every
 * `local` pattern of its definition, so files that stay on the machine that
 * wrote them never enter a commit, plain `git add -A` included (ADR-0592).
 * It only adds lines: a person's own lines stay as they are, and so does a
 * pattern a Sync brought from another device.
 *
 * Both go through the host's storage rather than the handle's writes, so a
 * publication never waits on itself: each schema as a put guarded by the
 * hash it read, which replaces the file, and `.gitignore` through the one
 * write (`writeFile`), which merges with it.
 */
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { FolderStorage } from './boundary.js';
import { formatDefinition } from './declaration.js';
import type { Definition } from './definition.js';
import { WriteError } from './errors.js';
import { hashBytes } from './hash.js';
import { sameContent } from './merge-file.js';
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
	DefinitionPublicationUnconfirmed: ({
		path,
		cause,
	}: {
		path: string;
		cause: unknown;
	}) => ({
		message: `Publication of ${path} did not confirm a complete save.`,
		path,
		cause,
	}),
	LocalPatternsUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Adding the folder's local patterns to ${GITIGNORE_PATH} did not confirm a complete save.`,
		path: GITIGNORE_PATH,
		cause,
	}),
});

/**
 * Await one publication of each table of `prepared` at its
 * `<table>/.epicenter.json`: the formatted schema put over the file it read,
 * guarded by that file's hash, so the schema replaces what it read whole. A
 * file already holding the schema is left as it is. Another writer landing
 * between the read and the put makes the put stale, and the publication
 * reads that file and replaces it instead, at most `WRITE_ATTEMPTS` times;
 * it never merges with it. A failure is logged per file and never refuses
 * the write it precedes, nor the other tables' publications.
 *
 * Answers the definition's `local` patterns, for `.gitignore`.
 */
export async function publishDefinition(
	prepared: Definition,
	storage: Publisher,
): Promise<readonly string[]> {
	for (const [path, text] of Object.entries(formatDefinition(prepared)))
		await publishFile(path, encoder.encode(text), storage);
	return prepared.local ?? [];
}

/** One schema file's publication: `bytes` replace what `path` held, or a failure is logged. */
async function publishFile(
	path: string,
	bytes: Uint8Array,
	storage: Publisher,
): Promise<void> {
	let failure: unknown = WriteError.KeptChanging({
		path,
		attempts: WRITE_ATTEMPTS,
	}).error;
	try {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const read = await storage.read(path);
			if (read.error !== null && read.error.name !== 'NotFound') {
				failure = writeFailure(path, read.error);
				break;
			}
			const current = read.error === null ? read.data : null;
			if (current !== null && sameContent(bytes, current.bytes)) return;
			const { data: put, error } = await confirmedPut(
				storage,
				path,
				bytes,
				current?.sha256 ?? null,
				await hashBytes(bytes),
			);
			if (error !== null) {
				failure = writeFailure(path, error);
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
		PublicationError.DefinitionPublicationUnconfirmed({ path, cause: failure }),
	);
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
			const next = gitignoreNaming(
				current === null ? '' : new TextDecoder().decode(current),
				local,
			);
			if (next === undefined) return;
			const { error } = await writeFile(
				storage,
				GITIGNORE_PATH,
				current,
				next,
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

/**
 * `.gitignore` text that names each of `local` as a line: `text` with the
 * missing patterns added at its end, or `undefined` when every pattern is
 * already one of its lines. Nothing in `text` is reordered, rewritten, or
 * removed.
 */
export function gitignoreNaming(
	text: string,
	local: readonly string[],
): string | undefined {
	const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
	const missing = local.filter((pattern) => !lines.has(pattern));
	if (missing.length === 0) return undefined;
	const separator = text === '' || text.endsWith('\n') ? '' : '\n';
	return `${text}${separator}${missing.join('\n')}\n`;
}
