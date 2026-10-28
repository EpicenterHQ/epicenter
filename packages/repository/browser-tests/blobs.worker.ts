/**
 * Checks of the OPFS blob store that no repository call can reach: a put
 * whose oid does not match its bytes, and a temporary file left by a worker
 * that died mid-put. Each runs against a repository's blob directory and
 * answers what it saw.
 */
import { createOpfsBlobStore, opfsBlobDirectory } from '../src/browser/blob-store.js';
import { sha256 } from '../src/hash.js';

type Check = { name: string; check: 'wrong-oid' | 'partial-temp' };

const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256);

async function names(directory: FileSystemDirectoryHandle) {
	const found: string[] = [];
	for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) found.push(name);
	return found.sort();
}

async function run({ name, check }: Check) {
	const directory = await opfsBlobDirectory(name);
	const store = createOpfsBlobStore(directory);
	const oid = await sha256(bytes);
	if (check === 'wrong-oid') {
		const other = await sha256(new Uint8Array([1, 2, 3]));
		const refused = await store.put(other, bytes, 'image/png').then(
			() => null,
			(cause: unknown) => String(cause),
		);
		return { refused, stored: await store.get(other), files: await names(directory) };
	}
	// What a worker killed mid-put leaves: half the bytes under a temporary name.
	const temporary = await directory.getFileHandle(`${oid}.${crypto.randomUUID()}.tmp`, { create: true });
	const access = await (temporary as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandleLike> }).createSyncAccessHandle();
	access.write(bytes.subarray(0, bytes.length / 2), { at: 0 });
	access.flush();
	access.close();
	const before = { bytes: await store.get(oid), url: await store.url(oid) };
	await store.put(oid, bytes, 'image/png');
	const stored = await store.get(oid);
	const url = await store.url(oid);
	const fetched = url === null ? null : await fetch(url);
	const result = {
		before,
		after: { size: stored?.length ?? null, oid: stored === null ? null : await sha256(stored) },
		type: fetched?.headers.get('content-type') ?? null,
		expected: { size: bytes.length, oid },
		files: await names(directory),
	};
	await store.close();
	return result;
}

type FileSystemSyncAccessHandleLike = {
	write(bytes: Uint8Array, options: { at: number }): number;
	flush(): void;
	close(): void;
};

addEventListener('message', async (event: MessageEvent<Check>) => {
	postMessage(await run(event.data));
});
