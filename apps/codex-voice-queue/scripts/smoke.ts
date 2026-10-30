import {
	createAppServerClient,
	spawnAppServer,
} from '../server/app-server-client.js';
import type {
	ThreadListResponse,
	ThreadTurnsListResponse,
} from '../src/lib/protocol.js';

const client = createAppServerClient({
	spawnProcess: () => spawnAppServer(process.env.CODEX_BIN ?? 'codex'),
});
try {
	await client.ensureReady();
	let cursor: string | undefined;
	let firstId: string | undefined;
	let pageNumber = 0;
	let total = 0;
	const cursors = new Set<string>();
	do {
		const page = await client.request<ThreadListResponse>('thread/list', {
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		firstId ??= page.data[0]?.id;
		total += page.data.length;
		console.log(`Page ${++pageNumber}: ${page.data.length} threads`);
		cursor = page.nextCursor ?? undefined;
		if (cursor && cursors.has(cursor))
			throw new Error('Repeated thread cursor');
		if (cursor) cursors.add(cursor);
	} while (cursor);
	console.log(`Total: ${total} threads`);
	if (firstId) {
		const turns = await client.request<ThreadTurnsListResponse>(
			'thread/turns/list',
			{ threadId: firstId, itemsView: 'full', limit: 10 },
		);
		console.log(`Turns on first page: ${turns.data.length}`);
		const counts: Record<string, number> = {};
		for (const turn of turns.data)
			for (const item of turn.items)
				counts[item.type] = (counts[item.type] ?? 0) + 1;
		console.log('Item type counts:', JSON.stringify(counts));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	client.stop();
}
