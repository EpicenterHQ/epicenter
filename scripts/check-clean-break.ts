/**
 * ADR-0843: new code imports nothing from the waiting folder sync product.
 * Fails when a source file or `package.json` under one of `NEW_CODE` names
 * one of its packages. Something worth keeping from the old code is copied
 * into the new code, never imported.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The packages written to ADR-0841. Each joins as it is written. */
const NEW_CODE = ['packages/app', 'packages/cli'];

/** The waiting product, by every spelling an import or a dependency uses. */
const WAITING =
	/@epicenter\/(?:definition|folder|server|local)\b|tauri-plugin-epicenter-folder|tauri-epicenter-standalone/;

const ignoredDirectories = new Set(['node_modules']);
const checkedFile = /\.(?:ts|js|svelte|json)$/;

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (ignoredDirectories.has(entry)) continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (checkedFile.test(entry)) yield path;
	}
}

const violations: string[] = [];
for (const root of NEW_CODE)
	for (const file of walk(root))
		for (const [index, line] of readFileSync(file, 'utf8')
			.split('\n')
			.entries())
			if (WAITING.test(line))
				violations.push(`${file}:${index + 1}  ${line.trim()}`);

if (violations.length > 0) {
	console.error(
		'New code imports the waiting folder sync product (ADR-0843). Copy what it needs instead:',
	);
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
