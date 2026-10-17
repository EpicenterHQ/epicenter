/**
 * Which folder an opener opens and how it reads it. Kept apart from the
 * folder engine, so an adapter decides before it loads the engine.
 */
import { Ok, type Result } from 'wellcrafted/result';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';

/**
 * Which folder a handle opens and how it reads it, decided by the one rule:
 * a folder's `epicenter.json` is published by the app the folder is named
 * after, and every other opener reads through its definition.
 *
 * `own` is the opening app's own folder, read with the app's prepared
 * `definition`, which the handle publishes before its first write. Any other
 * folder is read with its own `epicenter.json`, which the handle never
 * writes, and through `definition` when one was given: the declaration must
 * contain it (ADR-0538).
 */
export type Opening = {
	/** The folder's id: the host's name for it, never a path. */
	readonly id: string;
	/** The app that opened it, if an app did; a refusal names it. */
	readonly app?: string;
} & (
	| { readonly own: true; readonly definition: FolderDefinition }
	| { readonly own: false; readonly definition?: FolderDefinition }
);

/**
 * How to open the folder `id`: as `app`'s own when it is named after `app`
 * and a definition is given, through `definition` otherwise. A definition
 * a folder cannot keep is `InvalidDefinition`.
 */
export function opening(
	id: string,
	app: string | undefined,
	definition: FolderDefinition | undefined,
): Result<Opening, OpenFolderError> {
	if (definition === undefined) return Ok({ id, app, own: false });
	const { data: prepared, error } = prepareFolderDefinition(definition);
	if (error !== null) return OpenFolderError.InvalidDefinition(error);
	return Ok({ id, app, own: id === app, definition: prepared });
}
