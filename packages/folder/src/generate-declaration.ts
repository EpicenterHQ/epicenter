/**
 * Write a data folder's table schemas, each `<table>/.epicenter.json`, from
 * the `epicenter.ts` its author wrote (ADR-0527), in Bun. The definition's
 * `local` patterns are added to the root `.gitignore` (ADR-0592), which is
 * what keeps those files on one machine.
 *
 * This is the one reading of a folder that runs its code: it imports
 * `epicenter.ts` and keeps what its default export declares. Run it only on a
 * folder whose code you trust, as you would any script.
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { DEFINITION_SOURCE_PATH, hasDefinitionSource } from './check-folder.js';
import { formatDefinition } from './declaration.js';
import { defineFolder } from './definition.js';
import { nameLocalPatterns, writeSchemaFile } from './publish-definition.js';

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
	/** A file the definition declares could not be written; earlier ones may have been. */
	WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `${path} could not be written: ${cause instanceof Error ? cause.message : typeof cause === 'object' && cause !== null && 'message' in cause ? String(cause.message) : String(cause)}`,
		path,
		cause,
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
 * Run `<dir>/epicenter.ts` and write the schema file of each table its
 * default export declares, and the `local` patterns `.gitignore` lacks.
 * `written` lists each file whose text changed, by its path in the folder;
 * none when every file already held exactly that text. Nothing is written
 * when the definition cannot be kept. A table directory the definition does
 * not declare is left as it is.
 */
export async function generateDefinition(
	dir: string,
): Promise<Result<{ written: string[] }, GenerateDefinitionError>> {
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
	let definition: ReturnType<typeof defineFolder>;
	try {
		definition = defineFolder(declared as Parameters<typeof defineFolder>[0]);
	} catch (cause) {
		return GenerateDefinitionError.InvalidDefinition({
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	// Each file goes through the folder's one write boundary, under its save
	// lock: a schema replaces what it read only while it still holds that,
	// and `.gitignore` merges with what another writer added meanwhile.
	const { directoryStorage } = await import('./bun.js');
	const storage = directoryStorage(await realpath(dir));
	const written: string[] = [];
	for (const [path, text] of Object.entries(formatDefinition(definition))) {
		const { data: changed, error } = await writeSchemaFile(path, text, storage);
		if (error !== null)
			return GenerateDefinitionError.WriteFailed({ path, cause: error });
		if (changed) written.push(path);
	}
	const { data: named, error } = await nameLocalPatterns(
		definition.local ?? [],
		storage,
	);
	if (error !== null)
		return GenerateDefinitionError.WriteFailed({
			path: '.gitignore',
			cause: error,
		});
	if (named) written.push('.gitignore');
	return Ok({ written });
}
