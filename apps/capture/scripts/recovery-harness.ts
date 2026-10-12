/**
 * Import a legacy bundle into a real directory, twice, and print what
 * happened. No sign-in, no server, no browser.
 *
 *   bun apps/capture/scripts/recovery-harness.ts [directory] [bundle.json]
 *
 * With no directory, a temporary one is created and its path printed; it is
 * left in place so the files can be inspected. With no bundle, the fixture in
 * `fixtures/legacy-bundle.json` is used. The second run is the retry: it must
 * create nothing.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { readLegacyBundle, runLegacyImport } from '@epicenter/capture/legacy';
import { openFolder } from '@epicenter/folder/bun';

const [directory, bundlePath] = process.argv.slice(2);
const root = directory ?? (await mkdtemp(join(tmpdir(), 'capture-recovery-')));
const read = readLegacyBundle(
	JSON.parse(
		await readFile(
			bundlePath ?? join(import.meta.dir, '../fixtures/legacy-bundle.json'),
			'utf8',
		),
	),
);
if (!read.ok) {
	console.error('Not a bundle:', read.problems);
	process.exit(2);
}

// Local history only: an explicit author, no remote, and one commit at the
// end instead of one per file.
const opened = await openFolder({
	root,
	definition: captureDefinition,
	git: {
		author: { name: 'Capture', email: 'capture@localhost' },
	},
});
if (opened.error) {
	console.error(opened.error.message);
	process.exit(2);
}
const folder = opened.data;
let exitCode = 0;
try {
	const first = await runLegacyImport(folder.files, read.bundle);
	const retry = await runLegacyImport(folder.files, read.bundle);
	const commit = await folder.git.commit();
	console.log(
		JSON.stringify(
			{
				root,
				first: {
					complete: first.complete,
					documents: first.documents.map(
						({ identity, kind, path, status, structured }) => ({
							identity,
							kind,
							path,
							status,
							sourceOnly: structured?.message,
						}),
					),
					diagnostics: first.diagnostics,
					receipt: first.receipt,
				},
				retry: {
					complete: retry.complete,
					created: retry.documents.filter((item) => item.status === 'created')
						.length,
					alreadyImported: retry.alreadyImported,
					receipt: retry.receipt,
				},
				commit: commit.status,
				captures: (await readdir(join(root, 'captures'))).sort(),
				recovery: (await readdir(join(root, 'recovery'))).sort(),
			},
			null,
			2,
		),
	);
	if (!first.complete || retry.documents.length > 0) exitCode = 1;
} finally {
	await folder.close();
}
process.exit(exitCode);
