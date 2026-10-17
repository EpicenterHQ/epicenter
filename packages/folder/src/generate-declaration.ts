/**
 * Write a data folder's `epicenter.json` from the `epicenter.ts` its author
 * wrote (ADR-0527), in Bun.
 *
 * This is the one reading of a folder that runs its code: it imports
 * `epicenter.ts` and keeps what its default export declares. Run it only on a
 * folder whose code you trust, as you would any script.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { DEFINITION_SOURCE_PATH, hasDefinitionSource } from './check-folder.js';
import { formatDefinition } from './declaration.js';
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
});
export type GenerateDefinitionError = InferErrors<
	typeof GenerateDefinitionError
>;

/**
 * What a folder's `epicenter.ts` may import without installing anything. A
 * data folder lives in any repository, so each name resolves to the modules
 * this process already holds, and a copy the folder installed never wins.
 * Bun ignores a runtime redirect of a bare specifier, so each name is listed.
 * Loading them here also puts them in a compiled binary.
 */
const DEFINITION_IMPORTS: Record<string, () => Promise<object>> = {
	'@epicenter/folder': () => import('./index.js'),
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
	const target = resolve(dir, DEFINITION_PATH);
	const current = await readFile(target, 'utf8').catch(() => undefined);
	if (current === text) return Ok({ written: false });
	await writeFile(target, text);
	return Ok({ written: true });
}
