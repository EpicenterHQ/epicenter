/**
 * Discovery publication through the ordinary file boundary (ADR-0517): the
 * folder's declaration, at `epicenter.json`, as JSON a tool can read without
 * running anything. A handle publishes it just before its first write, so a
 * folder nobody writes to is never touched, and a folder written to says
 * which definition last wrote it. A file that already holds the declaration's
 * bytes is left as it is.
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
const PublicationError = defineErrors({
	DefinitionPublicationUnconfirmed: ({ cause }: { cause: unknown }) => ({
		message: `Publication of ${DECLARATION_PATH} did not confirm a complete save.`,
		path: DECLARATION_PATH,
		cause,
	}),
});

/**
 * Await one create-or-replace attempt, skipped when the file already holds
 * the declaration's bytes. A failed read falls through to the write. A
 * discovery failure never refuses the write it precedes.
 */
export async function publishDefinition(
	prepared: FolderDefinition,
	files: Pick<FolderFiles, 'read' | 'overwrite'>,
): Promise<void> {
	const declaration = ownBytes(formatDeclaration(prepared));
	if (await holds(files, declaration)) return;
	try {
		const { error: writeError } = await files.overwrite(
			DECLARATION_PATH,
			declaration,
		);
		if (writeError !== null)
			log.error(
				PublicationError.DefinitionPublicationUnconfirmed({
					cause: writeError,
				}),
			);
	} catch (cause) {
		// A thrown write can also have landed. Retain the cause without claiming
		// the destination is missing, unchanged, or successfully published.
		log.error(PublicationError.DefinitionPublicationUnconfirmed({ cause }));
	}
}

/** Whether `epicenter.json` holds exactly `declaration`. A failed read is no. */
async function holds(
	files: Pick<FolderFiles, 'read'>,
	declaration: Uint8Array,
): Promise<boolean> {
	try {
		const { data: current, error } = await files.read(DECLARATION_PATH);
		return error === null && current.sha256 === (await hashBytes(declaration));
	} catch {
		return false;
	}
}

/**
 * `storage`, publishing the declaration once before the first change this
 * handle makes. Reads publish nothing. The publication's own write goes to
 * `storage` directly, and its failure is logged without refusing the write.
 */
export function declaring(
	storage: FolderStorage,
	prepared: FolderDefinition,
): FolderStorage {
	let published: Promise<void> | undefined;
	const files = createFiles({ storage });
	const first = () => {
		published ??= publishDefinition(prepared, files);
		return published;
	};
	return {
		...storage,
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
