/**
 * The browser's default local folder: `openFolder({ tables })`.
 *
 * One folder per web origin, kept in IndexedDB by the browser repository
 * engine (`./browser/`) and reopened under a fixed internal key. The key is
 * independent of any app name, account, or remote, and opening needs no
 * authentication, network, or schema file (ADR-0633, ADR-0636). The handle
 * is the public `Folder` (`folder.ts`).
 *
 * This handle reads no data kept by the older OPFS folders and does not
 * inspect or change them.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { isTableName, openRepository } from './browser/repository.js';
import { saveDelay } from './document-owner.js';
import { OpenFolderError } from './errors.js';
import type { DefaultFolderOptions, Folder } from './folder.js';
import { type EngineTable, folderHandle } from './handle.js';

/**
 * The fixed key of this origin's default local data. A web origin holds one
 * ordinary app (ADR-0636); separately isolated apps need separate origins.
 */
const DEFAULT_KEY = 'default';

export async function openLocalFolder<
	const TTables extends Record<string, Schema>,
>({
	tables,
	saveAfterMs,
}: DefaultFolderOptions<TTables>): Promise<
	Result<Folder<TTables>, OpenFolderError>
> {
	saveDelay(saveAfterMs);
	for (const table of Object.keys(tables))
		if (!isTableName(table)) return OpenFolderError.InvalidTable({ table });
	if (typeof indexedDB === 'undefined')
		return OpenFolderError.Unavailable({
			cause: new Error('IndexedDB is not available in this page'),
		});
	let repository: Awaited<ReturnType<typeof openRepository>>;
	try {
		repository = await openRepository(DEFAULT_KEY, tables);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return Ok(
		folderHandle(
			{
				files: repository.files,
				tables: repository.tables as Record<string, EngineTable>,
				subscribe: repository.onChange,
				close: repository.close,
			},
			tables,
			{ saveAfterMs },
		),
	);
}
