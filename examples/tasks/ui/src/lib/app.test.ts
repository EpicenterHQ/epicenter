/**
 * Exercises the app's mutation options through TanStack and its HTTP client.
 * A successful save remains visible when the following read fails, and retrying
 * that read never repeats the write. No real server or app data is used.
 */
import { Ok } from 'wellcrafted/result';
import { expect, spyOn, test } from 'bun:test';
import { MutationCache, MutationObserver, QueryClient, QueryObserver, } from '@tanstack/svelte-query';
// connect identifies its app from the browser URL when this module is loaded.
const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: { href: 'http://localhost/tasks/' },
});
const { reads, writes } = await import('./app.js');
if (location)
	Object.defineProperty(globalThis, 'location', location);
else
	Reflect.deleteProperty(globalThis, 'location');
/** The action a call runs: serve takes it at `/tasks/<action>`. */
const actionOf = (url: Parameters<typeof fetch>[0]) => /\/tasks\/([^/]+)$/.exec(String(url))?.[1];
/** A call that answered with what the action returned. */
const response = (returned: unknown) => new Response(`${JSON.stringify({ answer: { data: returned, error: null } })}\n`);
/** Serve refusing a call before it runs. */
const unavailable = () => new Response(JSON.stringify({ data: null, error: { kind: 'refused', reason: { name: 'Usage', message: 'unavailable' } } }), {
	status: 503,
});
function stub(answer: (action: string | undefined) => Response) {
	return spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0]) => answer(actionOf(url)), {
		preconnect: fetch.preconnect,
	}));
}
test('a saved record survives a failed refresh and retry only reads', async () => {
	const id = 'save-check';
	const before = { path: `data/tasks/${id}.md`, id, title: 'Save check', done: false, body: 'Before\n' };
	const saved = { ...before, body: 'Saved text\n' };
	let writeCount = 0;
	let readsFail = true;
	const transport = stub((action) => {
		if (action === 'get')
			return readsFail ? unavailable() : response(saved);
		writeCount++;
		return response(saved);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _previous, _mutation, { client }) => client.invalidateQueries(),
		}),
	});
	const options = reads.get({ id });
	client.setQueryData(options.queryKey, before);
	const view = new QueryObserver(client, { ...options, staleTime: Infinity });
	const stop = view.subscribe(() => { });
	try {
		const save = new MutationObserver(client, writes.edit);
		await save.mutate({ id, old: before.body, new: saved.body });
		expect(save.getCurrentResult().status).toBe('success');
		expect(view.getCurrentResult().isRefetchError).toBe(true);
		expect(view.getCurrentResult().data?.body).toBe(saved.body);
		readsFail = false;
		await client.refetchQueries({ queryKey: options.queryKey, exact: true });
		expect(view.getCurrentResult().isRefetchError).toBe(false);
		expect(view.getCurrentResult().data?.body).toBe(saved.body);
		expect(writeCount).toBe(1);
	}
	finally {
		stop();
		client.clear();
		transport.mockRestore();
	}
});
/** Exact caches are reconciled once per confirmed write, before failed invalidation reads. */
const id = 'save-check';
const confirmed = { path: `data/tasks/${id}.md`, id, title: 'Save check', done: false, body: 'Notes\n' };
function cacheClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _previous, _mutation, { client }) => client.invalidateQueries(),
		}),
	});
}
for (const loaded of [true, false])
	test(`add reconciles a ${loaded ? 'loaded empty' : 'missing'} list`, async () => {
		const client = cacheClient();
		const listKey = reads.list().queryKey;
		if (loaded)
			client.setQueryData(listKey, []);
		const view = loaded ? new QueryObserver(client, { ...reads.list(), staleTime: Infinity }) : undefined;
		const stop = view?.subscribe(() => { });
		let writesMade = 0;
		const transport = stub((action) => {
			if (action === 'add') {
				writesMade++;
				return response(confirmed);
			}
			return unavailable();
		});
		try {
			await new MutationObserver(client, writes.add).mutate({ title: confirmed.title });
			const row = confirmed;
			expect(client.getQueryData(listKey)).toEqual(loaded ? [Ok(row)] : undefined);
			if (view)
				expect(view.getCurrentResult().isRefetchError).toBe(true);
			expect(client.getQueryData(reads.get({ id }).queryKey)).toEqual(confirmed);
			await client.refetchQueries();
			expect(writesMade).toBe(1);
		}
		finally {
			stop?.();
			client.clear();
			transport.mockRestore();
		}
	});
for (const outcome of [true, false, 'failed'] as const)
	test(`delete ${outcome} reconciles only confirmed absence`, async () => {
		const client = cacheClient();
		const getKey = reads.get({ id }).queryKey;
		const listKey = reads.list().queryKey;
		const row = confirmed;
		const unrelated = { ...row, path: 'data/tasks/unrelated.md', id: 'unrelated' };
		client.setQueryData(getKey, confirmed);
		client.setQueryData(listKey, [Ok(row), Ok(unrelated)]);
		const view = new QueryObserver(client, { ...reads.list(), staleTime: Infinity });
		const stop = view.subscribe(() => { });
		let writesMade = 0;
		const transport = stub((action) => {
			if (action === 'delete') {
				writesMade++;
				return outcome === 'failed' ? unavailable() : response(outcome);
			}
			return unavailable();
		});
		try {
			const mutation = new MutationObserver(client, writes.delete);
			if (outcome === 'failed')
				await expect(mutation.mutate({ id })).rejects.toBeDefined();
			else
				await mutation.mutate({ id });
			expect(client.getQueryData(listKey)).toEqual(outcome === 'failed' ? [Ok(row), Ok(unrelated)] : [Ok(unrelated)]);
			expect(view.getCurrentResult().isRefetchError).toBe(true);
			expect(client.getQueryState(getKey)).toEqual(outcome === 'failed' ? expect.objectContaining({ data: confirmed }) : undefined);
			await client.refetchQueries();
			expect(writesMade).toBe(1);
		}
		finally {
			stop();
			client.clear();
			transport.mockRestore();
		}
	});
test('a confirmed repair replaces the Misfit cache row and deletion removes it', async () => {
	const client = cacheClient();
	const listKey = reads.list().queryKey;
	const broken = { data: null, error: { name: 'Misfit' as const, namespace: 'epicenter/action-error' as const, path: confirmed.path, message: 'Needs repair', problems: [{ line: 'Bad field', kind: 'field' }] } };
	client.setQueryData(listKey, [broken]);
	const transport = stub((action) => action === 'set' ? response(confirmed) : response(true));
	try {
		await new MutationObserver(client, writes.set).mutate({ id, done: false });
		const row = confirmed;
		expect(client.getQueryData(listKey)).toEqual([Ok(row)]);
		client.setQueryData(listKey, [broken]);
		await new MutationObserver(client, writes.delete).mutate({ id });
		expect(client.getQueryData(listKey)).toEqual([]);
	}
	finally {
		client.clear();
		transport.mockRestore();
	}
});

for (const body of ['', 'Before']) test(`notes save from ${body ? 'a quote' : 'an empty body'} sends one set`, async () => {
	const calls: string[] = [];
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
		calls.push(String(url));
		expect(JSON.parse(String(options?.body))).toEqual(body === '' ? { id: 'book', body: 'After' } : { id: 'book', edit: { old: body, new: 'After' } });
		return response({ id: 'book', path: 'data/tasks/book.md', title: 'Book', done: false, body: 'After' });
	}, { preconnect: fetch.preconnect }));
	const client = cacheClient();
	try {
		await new MutationObserver(client, writes.edit).mutate({ id: 'book', old: body, new: 'After' });
		expect(calls).toEqual(['/tasks/set']);
	} finally { client.clear(); transport.mockRestore(); }
});

test('a failed save reports its error without a recovery read or another write', async () => {
	const calls: (string | undefined)[] = [];
	const transport = stub(action => { calls.push(action); return new Response(''); });
	const client = cacheClient();
	try {
		await expect(new MutationObserver(client, writes.set).mutate({ id: 'book', done: true })).rejects.toMatchObject({ name: 'Unreachable' });
		expect(calls).toEqual(['set']);
	} finally { client.clear(); transport.mockRestore(); }
});
