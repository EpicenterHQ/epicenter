/**
 * The blob store's conformance checks, run in a worker against the OPFS
 * store: each check gets a fresh `objects/` directory of its own, under a
 * scratch directory that is removed after. Answers each check's name with
 * `ok` or why it broke.
 */
import { BLOB_STORE_CHECKS } from '../src/client/blobs.checks.js';
import { createOpfsBlobStore } from '../src/hosts/browser/objects.js';
import { entriesOf } from '../src/hosts/browser/opfs.js';

addEventListener('message', async () => {
	const root = await navigator.storage.getDirectory();
	const scratch = await root.getDirectoryHandle(`objects-checks-${crypto.randomUUID()}`, { create: true });
	const results: Record<string, string> = {};
	for (const [name, run] of Object.entries(BLOB_STORE_CHECKS)) {
		const directory = await scratch.getDirectoryHandle(String(Object.keys(results).length), { create: true });
		try {
			await run(createOpfsBlobStore(directory));
			// A store leaves only objects behind: no temporary file outlives a seal, failed or not.
			const stray = (await entriesOf(directory)).filter(([file]) => !/^[0-9a-f]{64}$/.test(file));
			results[name] = stray.length === 0 ? 'ok' : `stray files: ${stray.map(([file]) => file).join(', ')}`;
		} catch (cause) {
			results[name] = String(cause);
		}
	}
	await root.removeEntry(scratch.name, { recursive: true });
	postMessage(results);
});
