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
import type { FolderStorage } from './boundary.js';
import { hashBytes, ownBytes } from './capture.js';
import { formatDeclaration } from './declaration.js';
import type { FolderDefinition } from './definition.js';
import { createFiles, type FolderFiles } from './files.js';
import { DECLARATION_PATH } from './paths.js';

const log = createLogger('folder/definition');
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
 * Await one publication, skipped when the file already holds the
 * declaration's bytes. `epicenter.json` is never merged (ADR-0551): a
 * missing file is created, reading once more when another writer created it
 * first, and a present one is saved over as read with `{ merge: false }`,
 * reading once more when another writer saved first. A failure is logged and
 * never refuses the write it precedes.
 */
export async function publishDefinition(
	prepared: FolderDefinition,
	files: Pick<FolderFiles, 'read' | 'create' | 'save'>,
): Promise<void> {
	const declaration = ownBytes(formatDeclaration(prepared));
	const sha256 = await hashBytes(declaration);
	let failure: unknown;
	try {
		for (let reads = 0; reads < 2; reads++) {
			const { data: current, error: readError } =
				await files.read(DECLARATION_PATH);
			if (readError !== null && readError.name !== 'NotFound') {
				failure = readError;
				break;
			}
			if (readError === null && current.sha256 === sha256) return;
			const { error } =
				readError === null
					? await files.save(current, declaration, { merge: false })
					: await files.create(DECLARATION_PATH, declaration);
			if (error === null) return;
			failure = error;
			if (error.name !== 'Conflict' && error.name !== 'Exists') break;
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
 * removed, so a person's own lines stay. The save never merges: when another
 * writer saved first, the file is read once more. A failure is logged and
 * never refuses the write it precedes.
 */
export async function publishLocalPatterns(
	local: readonly string[],
	files: Pick<FolderFiles, 'read' | 'create' | 'save'>,
): Promise<void> {
	if (local.length === 0) return;
	let failure: unknown;
	try {
		for (let reads = 0; reads < 2; reads++) {
			const { data: current, error: readError } =
				await files.read(GITIGNORE_PATH);
			if (readError !== null && readError.name !== 'NotFound') {
				failure = readError;
				break;
			}
			const text =
				readError === null ? new TextDecoder().decode(current.bytes) : '';
			const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
			const missing = local.filter((pattern) => !lines.has(pattern));
			if (missing.length === 0) return;
			const separator = text === '' || text.endsWith('\n') ? '' : '\n';
			const next = `${text}${separator}${missing.join('\n')}\n`;
			const { error } =
				readError === null
					? await files.save(current, next, { merge: false })
					: await files.create(GITIGNORE_PATH, next);
			if (error === null) return;
			failure = error;
			if (error.name !== 'Conflict' && error.name !== 'Exists') break;
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
	const files = createFiles({ storage });
	const first = () => {
		published ??= publishDefinition(prepared, files).then(() =>
			publishLocalPatterns(prepared.local ?? [], files),
		);
		return published;
	};
	return {
		...storage,
		async put(path, bytes, ifMatch) {
			await first();
			return storage.put(path, bytes, ifMatch);
		},
		async apply(changes) {
			await first();
			return storage.apply(changes);
		},
		async mkdir(path) {
			await first();
			return storage.mkdir(path);
		},
	};
}
