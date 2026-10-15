/**
 * Which installed apps the Folders window offers on each folder (ADR-0537,
 * ADR-0538, ADR-0552).
 *
 * An app can open a folder when the folder's declaration contains the app's
 * shape: `shapeProblems(declared, shape)` finds nothing. An installed app
 * (ADR-0540) opens the folder it is handed at launch, so it is offered on
 * every folder whose declaration contains its shape: the declaration its
 * `epicenter.app.json` names as `opens`. Only an installed app that can run
 * is offered; one waiting for approval is not.
 *
 * Every installed app is also listed under Apps, where opening it hands it its
 * own folder.
 */

import {
	type DataSchema,
	prepareSchema,
	shapeProblems,
} from '@epicenter/definition';
import { parseDeclaration } from '@epicenter/folder';
import type { Application } from '../applications.ts';
import type { DataFolder, InstalledApp } from '../ui/bindings.gen';

/** An app that opens a folder, and the shape it reads. */
export type FolderOpener = {
	application: Application;
	shape: DataSchema;
};

/** The shape a declaration's text states, or `undefined` when it states none. */
function shapeOf(declaration: string | null): DataSchema | undefined {
	if (declaration === null) return undefined;
	const { data: parsed, error: parseError } = parseDeclaration(declaration);
	if (parseError !== null) return undefined;
	const { data: shape, error: prepareError } = prepareSchema(parsed);
	if (prepareError !== null) return undefined;
	return shape;
}

/**
 * The installed apps that can run, as openers of any folder their shape fits,
 * by title. An app whose `opens` declaration cannot be read opens no folder;
 * it is still listed under Apps.
 */
export function installedOpeners(
	apps: readonly InstalledApp[],
): FolderOpener[] {
	return apps
		.filter(({ state }) => state.kind === 'ready' || state.kind === 'unbuilt')
		.flatMap((app) => {
			const shape = shapeOf(app.opens);
			if (shape === undefined) return [];
			return [
				{
					application: { id: app.id, title: app.title },
					shape,
				} satisfies FolderOpener,
			];
		})
		.sort((a, b) => a.application.title.localeCompare(b.application.title));
}

/**
 * Whether `declaration`, the text of a folder's `epicenter.json`, contains
 * `shape`. A declaration that is absent, not JSON, or not a valid
 * declaration contains nothing.
 */
export function declarationContains(
	declaration: string | null,
	shape: DataSchema,
): boolean {
	const declared = shapeOf(declaration);
	if (declared === undefined) return false;
	return shapeProblems(declared, shape).length === 0;
}

/** The apps the window offers on `folder`, as "Open in" or "Open with". */
export function openersOf(
	folder: Pick<DataFolder, 'declaration'>,
	openers: readonly FolderOpener[],
): Application[] {
	return openers
		.filter(({ shape }) => declarationContains(folder.declaration, shape))
		.map(({ application }) => application);
}
