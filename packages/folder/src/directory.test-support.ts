/**
 * Test helper: open a directory folder as the app it is named after, so a
 * definition is published there, failing the test when it is refused.
 */
import { basename } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { type Definition, openFolder } from './bun.js';
import type { FolderGitOptions } from './folder.js';

export { openFolder };

export async function openNativeFolder<
	const TDefinition extends Definition,
>(options: {
	readonly root: string;
	readonly definition: TDefinition;
	readonly git: FolderGitOptions;
}) {
	return expectOk(
		await openFolder({ ...options, app: basename(options.root) }),
	);
}
