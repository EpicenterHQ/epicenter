/**
 * Every declared compiled application builds with its expected base path.
 *
 * This is the only check that runs each application's real Epicenter build. It
 * goes through Epicenter's own `build:<id>` script, so a declared application
 * with no working build script fails here rather than at a user's next launch,
 * and it reads the emitted document, so a build whose base path disagrees with
 * where the host serves it (`/apps/<id>/`) fails here rather than booting
 * blank.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPILED_APPLICATIONS } from '../src/applications.ts';

const epicenterDir = fileURLToPath(new URL('..', import.meta.url));

const BUILD_TIMEOUT_MS = 180_000;

async function run(script: string, cwd: string): Promise<void> {
	const built = Bun.spawn(['bun', 'run', script], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [status, stderr] = await Promise.all([
		built.exited,
		new Response(built.stderr).text(),
	]);
	if (status !== 0) {
		throw new Error(`\`bun run ${script}\` in ${cwd} failed:\n${stderr}`);
	}
}

describe('compiled application builds', () => {
	for (const application of COMPILED_APPLICATIONS) {
		test(
			`${application.title} builds with its /apps/${application.id}/ base path`,
			async () => {
				await run(`build:${application.id}`, epicenterDir);

				const page = await Bun.file(
					join(epicenterDir, 'dist', application.id, 'index.html'),
				).text();
				expect(page).toContain(`/apps/${application.id}/`);
			},
			BUILD_TIMEOUT_MS,
		);
	}
});
