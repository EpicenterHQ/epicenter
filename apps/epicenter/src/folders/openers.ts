/**
 * Which apps the Folders window offers on each folder, and which it lists on
 * their own (ADR-0537, ADR-0538).
 *
 * An app can open a folder when the folder's declaration contains the app's
 * shape: `shapeProblems(declared, shape)` finds nothing. The built-in apps
 * that open folders are compiled in, so each one's shape is its own folder
 * definition, imported from the package that defines it.
 *
 * A built-in app opens only its own folder today: launching Todos opens
 * `so.epicenter.todos`, whatever folder the click came from. So the window
 * offers a built-in app on a folder only when that folder is the app's own
 * (`DataFolder.app`) and its declaration contains the app's shape.
 *
 * An installed app (ADR-0540) opens the folder it is handed at launch, so it
 * is offered on every folder whose declaration contains its shape: the
 * declaration its `epicenter.app.json` names as `opens`. Only an installed
 * app that can run is offered; one waiting for approval is not.
 *
 * Every compiled application not offered on a listed folder is listed under
 * Apps, so an app whose folder does not exist yet stays one click away.
 */

import { captureDefinition } from '@epicenter/capture/definition';
import {
	type DataSchema,
	prepareSchema,
	shapeProblems,
} from '@epicenter/definition';
import { parseDeclaration } from '@epicenter/folder';
import { todosDefinition } from '@epicenter/todos/definition';
import {
	type Application,
	CAPTURE_APPLICATION,
	COMPILED_APPLICATIONS,
	FOLDERS_APPLICATION,
	TODOS_APPLICATION,
} from '../applications.ts';
import type { DataFolder, InstalledApp } from '../ui/bindings.gen';

/** An app that opens a folder, and the shape it reads. */
export type FolderOpener = {
	application: Application;
	shape: DataSchema;
	/**
	 * Whether it opens any folder whose declaration contains its shape, as an
	 * installed app does, or only its own, as a built-in app does today.
	 */
	opensAnyFolder: boolean;
};

/** The built-in apps that open a folder, in the order the window offers them. */
export const FOLDER_OPENERS: readonly FolderOpener[] = [
	{
		application: TODOS_APPLICATION,
		shape: todosDefinition,
		opensAnyFolder: false,
	},
	{
		application: CAPTURE_APPLICATION,
		shape: captureDefinition,
		opensAnyFolder: false,
	},
];

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
					application: { id: app.id, title: app.title, installed: true },
					shape,
					opensAnyFolder: true,
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
	folder: Pick<DataFolder, 'app' | 'declaration'>,
	openers: readonly FolderOpener[] = FOLDER_OPENERS,
): Application[] {
	return openers
		.filter(
			({ application, shape, opensAnyFolder }) =>
				(opensAnyFolder || folder.app === application.id) &&
				declarationContains(folder.declaration, shape),
		)
		.map(({ application }) => application);
}

/**
 * The compiled applications listed under Apps: every one except the Folders
 * window itself and those `offered` on a folder.
 */
export function appsWithoutFolder(
	offered: Iterable<Application>,
): Application[] {
	const onAFolder = new Set([...offered].map(({ id }) => id));
	return COMPILED_APPLICATIONS.filter(
		({ id }) => id !== FOLDERS_APPLICATION.id && !onAFolder.has(id),
	);
}
