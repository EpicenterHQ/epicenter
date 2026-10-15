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
import {
	DECLARATION_SOURCE_PATH,
	hasDeclarationSource,
} from './check-folder.js';
import { formatDeclaration } from './declaration.js';
import { defineFolder } from './definition.js';
import { DECLARATION_PATH } from './paths.js';

export const GenerateDeclarationError = defineErrors({
	/** The folder has no `epicenter.ts`. */
	NoSource: ({ dir }: { dir: string }) => ({
		message: `'${dir}' has no ${DECLARATION_SOURCE_PATH} to generate from`,
		dir,
	}),
	/** `epicenter.ts` threw while it ran. */
	SourceFailed: ({ source, cause }: { source: string; cause: unknown }) => ({
		message: `${source} could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
		source,
		cause,
	}),
	/** The default export is not a declaration a folder can keep. */
	InvalidDeclaration: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
});
export type GenerateDeclarationError = InferErrors<
	typeof GenerateDeclarationError
>;

/**
 * What a folder's `epicenter.ts` may import without installing anything. A
 * data folder lives in any repository, so each name resolves to the modules
 * this process already holds, and a copy the folder installed never wins.
 * Bun ignores a runtime redirect of a bare specifier, so each name is listed.
 * Loading them here also puts them in a compiled binary.
 */
const DECLARATION_IMPORTS: Record<string, () => Promise<object>> = {
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

async function resolveDeclarationImports() {
	const modules = await Promise.all(
		Object.entries(DECLARATION_IMPORTS).map(
			async ([specifier, load]) => [specifier, await load()] as const,
		),
	);
	Bun.plugin({
		name: 'epicenter-declaration-imports',
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
 * Nothing is written when the declaration cannot be kept.
 */
export async function generateDeclaration(
	dir: string,
): Promise<Result<{ written: boolean }, GenerateDeclarationError>> {
	if (!hasDeclarationSource(dir))
		return GenerateDeclarationError.NoSource({ dir });
	const source = resolve(dir, DECLARATION_SOURCE_PATH);
	await resolveDeclarationImports();
	let declared: unknown;
	try {
		declared = (await import(pathToFileURL(source).href)).default;
	} catch (cause) {
		return GenerateDeclarationError.SourceFailed({ source, cause });
	}
	if (typeof declared !== 'object' || declared === null)
		return GenerateDeclarationError.InvalidDeclaration({
			reason: `${DECLARATION_SOURCE_PATH} must \`export default defineFolder({ kv, tables })\``,
		});
	// defineFolder refuses what a folder cannot keep, and returns a prepared
	// definition as it is.
	let text: string;
	try {
		text = formatDeclaration(
			defineFolder(declared as Parameters<typeof defineFolder>[0]),
		);
	} catch (cause) {
		return GenerateDeclarationError.InvalidDeclaration({
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
	const target = resolve(dir, DECLARATION_PATH);
	const current = await readFile(target, 'utf8').catch(() => undefined);
	if (current === text) return Ok({ written: false });
	await writeFile(target, text);
	return Ok({ written: true });
}
