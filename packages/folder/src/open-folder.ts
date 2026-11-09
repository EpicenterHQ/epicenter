/**
 * `openFolder(contract, place)`: the one way to a folder, on every build
 * (ADR-0773). The place says where (`home`, `directory`, or `memory` under
 * test); the folder holds the contract's collections over that place's
 * store, opening at once.
 */
import type { Contract } from '@epicenter/definition/contract';
import { createFolder, type Folder } from './folder.js';
import { openingOf, type Place } from './place.js';

/** Where a folder records the place it was opened at; a symbol member, so `reactive`'s copy carries it. */
export const PLACE = Symbol('epicenter.folderPlace');

/**
 * The folder of `contract` at `place`, opening at once. A contract that is
 * not well formed throws.
 *
 * ```ts
 * export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
 * const scratch = openFolder(todos, directory('/tmp/todos'));
 * ```
 */
export function openFolder<TContract extends Contract>(
	contract: TContract,
	place: Place,
): Folder<TContract> {
	const opening = openingOf(place, contract);
	const folder = createFolder(contract, opening.open, {
		reveal: opening.reveal ?? null,
		displayPath: opening.displayPath,
	});
	Object.defineProperty(folder, PLACE, { value: place });
	return folder;
}

/** The place `folder` (or `reactive`'s copy of it) was opened at, when `openFolder` opened it. */
export function placeOf(folder: object): Place | undefined {
	return (folder as { [PLACE]?: Place })[PLACE];
}
