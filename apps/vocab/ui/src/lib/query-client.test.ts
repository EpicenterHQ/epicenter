import { expect, test } from 'bun:test';
import { MutationObserver, QueryObserver } from '@tanstack/svelte-query';
import { createQueryClient } from './query-client.ts';

test('every write refreshes every read the page shows, before the write is done', async () => {
	let lists = 0;
	const list = { queryKey: ['words'], queryFn: async () => [{ list: ++lists }] };
	const client = createQueryClient();
	const stop = new QueryObserver(client, list).subscribe(() => {});
	try {
		await client.query(list);
		expect<unknown>(client.getQueryData(['words'])).toEqual([{ list: 1 }]);
		await new MutationObserver(client, {
			mutationFn: async () => true,
		}).mutate();
		expect<unknown>(client.getQueryData(['words'])).toEqual([{ list: 2 }]);
	} finally {
		stop();
		client.clear();
	}
});
