/**
 * Write a data folder's `epicenter.json` from the `epicenter.ts` its author
 * wrote (ADR-0527), in Bun.
 *
 * This is the one reading of a folder that runs its code: it imports
 * `epicenter.ts` and keeps what its default export declares. Run it only on a
 * folder whose code you trust, as you would any script.
 *
 * The `epicenter.json` it replaces may hold a `local` list a person wrote by
 * hand, which the folder's history reads to keep files on this computer.
 * Generating refuses, writing nothing, when `epicenter.ts` leaves out a
 * pattern the current file lists as read just before the write. That read
 * and the write are two steps under no lock, so an edit saved to
 * `epicenter.json` between them is replaced unchecked: generate while
 * nothing else edits the file.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { DEFINITION_SOURCE_PATH, hasDefinitionSource } from './check-folder.js';
import { formatDefinition, parseLocalPolicy } from './declaration.js';
import { defineFolder } from './definition.js';
import { DEFINITION_PATH } from './paths.js';

export const GenerateDefinitionError = defineErrors({
	/** The folder has no `epicenter.ts`. */
	NoSource: ({ dir }: { dir: string }) => ({
		message: `'${dir}' has no ${DEFINITION_SOURCE_PATH} to generate from`,
		dir,
	}),
	/** `epicenter.ts` threw while it ran. */
	SourceFailed: ({ source, cause }: { source: string; cause: unknown }) => ({
		message: `${source} could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
		source,
		cause,
	}),
	/** The default export is not a definition a folder can keep. */
	InvalidDefinition: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	/**
	 * The folder's current `epicenter.json` keeps files local that the
	 * generated one would not, or cannot be read for what it keeps.
	 */
	DropsLocal: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
});
export type GenerateDefinitionError = InferErrors<
	typeof GenerateDefinitionError
>;

/**
 * What a folder's `epicenter.ts` may import without installing anything. A
 * data folder lives in any repository, so each name resolves to the modules
 * this process already holds, and a copy the folder installed never wins.
 * Bun ignores a runtime redirect of a bare specifier, so each name is listed.
 * Loading them here also puts them in a compiled binary. `@epicenter/folder`
 * is the Bun entry here, which holds `defineFolder`, `defineTable`, and
 * `field`, so a file written for the older root entry still runs.
 */
const DEFINITION_IMPORTS: Record<string, () => Promise<object>> = {
	'@epicenter/folder': () => import('./bun.js'),
	'@epicenter/folder/bun': () => import('./bun.js'),
	'@epicenter/definition': () => import('@epicenter/definition'),
	'@epicenter/definition/field': () => import('@epicenter/definition/field'),
	typebox: () => import('typebox'),
	'typebox/compile': () => import('typebox/compile'),
	'typebox/format': () => import('typebox/format'),
	'typebox/schema': () => import('typebox/schema'),
	'typebox/system': () => import('typebox/system'),
	'typebox/value': () => import('typebox/value'),
};

async function resolveDefinitionImports() {
	const modules = await Promise.all(
		Object.entries(DEFINITION_IMPORTS).map(
			async ([specifier, load]) => [specifier, await load()] as const,
		),
	);
	Bun.plugin({
		name: 'epicenter-definition-imports',
		setup(build) {
			for (const [specifier, exports] of modules)
				build.module(specifier, () => ({
					exports: { ...exports },
					loader: 'object',
				}));
		},
	});
}

/**
 * Run `<dir>/epicenter.ts` and write the `epicenter.json` its default export
 * declares. `written` is false when the file already held exactly that text.
 * Nothing is written when the definition cannot be kept.
 */
export async function generateDefinition(
	dir: string,
): Promise<Result<{ written: boolean }, GenerateDefinitionError>> {
	if (!hasDefinitionSource(dir))
		return GenerateDefinitionError.NoSource({ dir });
	const source = resolve(dir, DEFINITION_SOURCE_PATH);
	await resolveDefinitionImports();
	let declared: unknown;
	try {
		declared = (await import(pathToFileURL(source).href)).default;
	} catch (cause) {
		return GenerateDefinitionError.SourceFailed({ source, cause });
	}
	if (typeof declared !== 'object' || declared === null)
		return GenerateDefinitionError.InvalidDefinition({
			reason: `${DEFINITION_SOURCE_PATH} must \`export default defineFolder({ tables })\``,
		});
	// defineFolder refuses what a folder cannot keep, and returns a prepared
	// definition as it is.
	let text: string;
	try {
		text = formatDefinition(
			defineFolder(declared as Parameters<typeof defineFolder>[0]),
		);
	} catch (cause) {
		return GenerateDefinitionError.InvalidDefinition({
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	// What the folder's history reads from the generated file: a pattern that
	// would keep `epicenter.json` itself local is refused there, so here.
	const { data: generated, error: policyError } = parseLocalPolicy(
		new TextEncoder().encode(text),
	);
	if (policyError !== null)
		return GenerateDefinitionError.InvalidDefinition({
			reason: policyError.reason,
		});
	const target = resolve(dir, DEFINITION_PATH);
	let current: Uint8Array | undefined;
	try {
		current = await readFile(target);
	} catch (cause) {
		if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'))
			return GenerateDefinitionError.DropsLocal({
				reason: `${DEFINITION_PATH} was not replaced: it could not be read (${cause instanceof Error ? cause.message : String(cause)}). Fix the file, then generate again`,
			});
	}
	if (current !== undefined) {
		const { data: kept, error } = parseLocalPolicy(current);
		if (error !== null)
			return GenerateDefinitionError.DropsLocal({
				reason: `${DEFINITION_PATH} was not replaced: what it keeps on this computer cannot be read (${error.reason}). Fix or remove it, then generate again`,
			});
		const dropped = kept.filter((pattern) => !generated.includes(pattern));
		if (dropped.length > 0) {
			const listed = dropped.map((pattern) => `'${pattern}'`).join(', ');
			return GenerateDefinitionError.DropsLocal({
				reason: `${DEFINITION_PATH} was not replaced: it keeps ${listed} on this computer, which ${DEFINITION_SOURCE_PATH} does not declare. Add ${listed} to \`local\` in ${DEFINITION_SOURCE_PATH} to keep those files local, or remove ${listed} from ${DEFINITION_PATH} to share them, then generate again`,
			});
		}
		if (new TextDecoder().decode(current) === text)
			return Ok({ written: false });
	}
	await writeFile(target, text);
	return Ok({ written: true });
}
