/**
 * Each of Epicenter's own pages builds, and is built for where the shell
 * serves it: `epicenter-app://localhost/<page>/` (ADR-0561).
 *
 * This is the only check that runs each page's real build. It goes through
 * Epicenter's own `build:<page>` script, so a page with no working build
 * script fails here rather than at the next launch, and it reads the emitted
 * document, so a build whose base path disagrees with where the shell serves
 * it fails here rather than booting blank.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_PAGES } from './build-bundled-apps.ts';

const epicenterDir = fileURLToPath(new URL('..', import.meta.url));

/** The pages `BuiltInApp` in `src-tauri/src/lib.rs` opens, by id. */
const PAGES = ['home', 'folders'] as const;

const BUILD_TIMEOUT_MS = 180_000;

async function run(
	script: string,
	cwd: string,
	...args: string[]
): Promise<void> {
	const built = Bun.spawn(['bun', 'run', script, ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [status, stderr] = await Promise.all([
		built.exited,
		new Response(built.stderr).text(),
	]);
	if (status !== 0) {
		throw new Error(
			`\`bun run ${[script, ...args].join(' ')}\` in ${cwd} failed:\n${stderr}`,
		);
	}
}

describe('page builds', () => {
	for (const page of PAGES) {
		test(
			`${page} builds below /${page}/`,
			async () => {
				await run(`build:${page}`, epicenterDir);

				const document = await Bun.file(
					join(epicenterDir, 'dist', page, 'index.html'),
				).text();
				expect(document).toContain(`src="/${page}/assets/`);
			},
			BUILD_TIMEOUT_MS,
		);
	}

	// Each app Epicenter bundles is built from `apps/<page>` and served below
	// `/<page>/` (`BundledApp` in `src-tauri/src/bundled_apps.rs`). Its
	// installed build loads its assets by relative path, so it runs wherever
	// the shell serves it.
	for (const page of BUNDLED_PAGES) {
		test(
			`${page} builds into dist/${page} with relative assets`,
			async () => {
				await run('build:bundled', epicenterDir, page);

				const document = await Bun.file(
					join(epicenterDir, 'dist', page, 'index.html'),
				).text();
				expect(document).toContain('"./_app/');
				expect(document).not.toContain('"/_app/');
			},
			BUILD_TIMEOUT_MS,
		);
	}
});
