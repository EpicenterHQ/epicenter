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
 * Before any of it, the app's own folder's root `.gitignore` names every
 * `local` pattern of its definition, so files that stay on the machine that
 * wrote them never enter a commit, plain `git add -A` included (ADR-0592).
 * That is no best-effort step: opening the folder writes the lines, and the
 * open fails when it cannot, so nothing such as a recording starts before
 * them; a handle's change checks them again first and is refused while they
 * are missing. It only adds lines: a person's own lines stay as they are,
 * and so does a pattern a Sync brought from another device.
 *
 * Both go through the host's storage rather than the handle's writes, so a
 * publication never waits on itself: each schema as a put guarded by the
 * hash it read, which replaces the file, and `.gitignore` through the one
 * write (`writeFile`), which merges with it.
 */
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
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
export const GITIGNORE_PATH = '.gitignore';
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
});

/**
 * Await one publication of `prepared`'s schemas, each table's at its
 * `<table>/.epicenter.json` (`writeSchemaFile`). A failure is logged per
 * file and never refuses the write it precedes, nor the other files'
 * publications. Answers whether every file is confirmed, so a handle whose
 * publication failed tries again before its next write. The `local` lines
 * are not this best-effort step: they are a prerequisite (`nameLocalPatterns`).
 */
export async function publishDefinition(
	prepared: Definition,
	storage: Publisher,
): Promise<boolean> {
	let confirmed = true;
	for (const [path, text] of Object.entries(formatDefinition(prepared))) {
		const { error } = await writeSchemaFile(path, text, storage);
		if (error === null) continue;
		confirmed = false;
		log.error(
			PublicationError.DefinitionPublicationUnconfirmed({ path, cause: error }),
		);
	}
	return confirmed;
}

/**
 * Put `text` at the schema file `path`, over the file it read and guarded
 * by that file's hash, so the schema replaces what it read whole. A file
 * already holding the text is left as it is (`false`); `true` when it was
 * written. Another writer landing between the read and the put makes the put
 * stale, and the file is read and replaced again, at most `WRITE_ATTEMPTS`
 * times; it never merges with it. A thrown write can also have landed, so
 * its cause is the failure, claiming nothing about the file.
 */
export async function writeSchemaFile(
	path: string,
	text: string,
	storage: Publisher,
): Promise<Result<boolean, unknown>> {
	const bytes = encoder.encode(text);
	try {
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const read = await storage.read(path);
			if (read.error !== null && read.error.name !== 'NotFound')
				return Err(writeFailure(path, read.error));
			const current = read.error === null ? read.data : null;
			if (current !== null && sameContent(bytes, current.bytes))
				return Ok(false);
			const { data: put, error } = await confirmedPut(
				storage,
				path,
				bytes,
				current?.sha256 ?? null,
				await hashBytes(bytes),
			);
			if (error !== null) return Err(writeFailure(path, error));
			if (put === 'landed') return Ok(true);
		}
	} catch (cause) {
		return Err(cause);
	}
	return Err(WriteError.KeptChanging({ path, attempts: WRITE_ATTEMPTS }).error);
}

/**
 * Make the root `.gitignore` name each `local` pattern, skipped when every
 * pattern is already one of its lines (`false`); `true` when it was written.
 * A missing file is created holding the patterns. A present one gains the
 * missing patterns as lines at its end; nothing in it is reordered,
 * rewritten, or removed, so a person's own lines stay. The addition is
 * written with the one write, from the file as it was read, so a line
 * another writer adds meanwhile stays too; the file is read again until it
 * names every pattern, since a line another writer removed meanwhile stays
 * removed in that merge. Only a missing file reads as empty: any other read
 * failure is the answer, and nothing is written.
 */
export async function nameLocalPatterns(
	local: readonly string[],
	storage: Publisher,
): Promise<Result<boolean, unknown>> {
	if (local.length === 0) return Ok(false);
	let written = false;
	try {
		// Read again after each write: the merge keeps a line another writer
		// removed meanwhile, so a landed write is not yet every pattern.
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			const read = await storage.read(GITIGNORE_PATH);
			if (read.error !== null && read.error.name !== 'NotFound')
				return Err(writeFailure(GITIGNORE_PATH, read.error));
			const current = read.error === null ? read.data.bytes : null;
			const next = gitignoreNaming(
				current === null ? '' : new TextDecoder().decode(current),
				local,
			);
			if (next === undefined) return Ok(written);
			const { error } = await writeFile(
				storage,
				GITIGNORE_PATH,
				current,
				next,
				{ joining: true },
			);
			if (error !== null) return Err(error);
			written = true;
		}
	} catch (cause) {
		return Err(cause);
	}
	return Err('another writer kept removing the patterns');
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
	// Literal lines: ` audio/` is another pattern than `audio/`, as Git reads it.
	const lines = new Set(text.split(/\r?\n/));
	const missing = local.filter((pattern) => !lines.has(pattern));
	if (missing.length === 0) return undefined;
	const separator = text === '' || text.endsWith('\n') ? '' : '\n';
	return `${text}${separator}${missing.join('\n')}\n`;
}
