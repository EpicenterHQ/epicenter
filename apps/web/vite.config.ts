import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defineConfig, mergeConfig } from 'vite';

/** The first-party bundles compiled into the shell, by package directory. */
const BUNDLES = ['todos', 'honeycrisp'] as const;

/**
 * The SHA-256 of a package's source as this build compiles it: every file
 * under `src/` and its `package.json`, by relative path. An install records
 * it (`src/lib/installed.ts`); a change to the app's source is a new hash.
 */
function sourceHash(dir: string) {
	const hash = createHash('sha256');
	const files = [join(dir, 'package.json'), ...readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))];
	for (const file of files.map((path) => relative(dir, path)).sort()) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update('\0');
	return `sha256-${hash.digest('hex')}`;
}

export default defineConfig(
	mergeConfig(workspaceAppViteConfig({ port: 5190 }), {
		server: { host: '127.0.0.1' },
		define: { __BUNDLE_HASHES__: JSON.stringify(Object.fromEntries(BUNDLES.map((name) => [name, sourceHash(join(import.meta.dirname, '..', name))]))) },
		// SQLite's wasm loads relative to its own module, which pre-bundling would move.
		optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
		// The repository's worker is a module worker that imports SQLite.
		worker: { format: 'es' },
	}),
);
