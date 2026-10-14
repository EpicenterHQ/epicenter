/**
 * Discovery publication through the ordinary file boundary (ADR-0517): the
 * folder's declaration, at `epicenter.json`, as JSON a tool can read without
 * running anything. A handle publishes it just before its first write, so a
 * folder nobody writes to is never touched, and a folder written to says
 * which definition last wrote it.
 */
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { formatDeclaration } from './declaration.js';
import type { FolderStorage } from './boundary.js';
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

/** Await one create-or-replace attempt; a discovery failure never refuses opening. */
export async function publishDefinition(
	prepared: FolderDefinition,
	files: Pick<FolderFiles, 'overwrite'>,
): Promise<void> {
	try {
		const { error: writeError } = await files.overwrite(
			DECLARATION_PATH,
			formatDeclaration(prepared),
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
