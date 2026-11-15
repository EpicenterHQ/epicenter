/**
 * Exercises the app's mutation options through TanStack and its HTTP client.
 * A successful save remains visible when the following read fails, and retrying
 * that read never repeats the write. No real server or app data is used.
 */
import { expect, spyOn, test } from 'bun:test';
import {
	MutationCache,
	MutationObserver,
	QueryClient,
	QueryObserver,
} from '@tanstack/svelte-query';

// connect identifies its app from the browser URL when this module is loaded.
const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: { href: 'http://localhost/tasks/' },
});
const { reads, writes } = await import('./app.js');
if (location) Object.defineProperty(globalThis, 'location', location);
else Reflect.deleteProperty(globalThis, 'location');

test('a saved record survives a failed refresh and retry only reads', async () => {
	const path = 'data/tasks/save-check.md';
	const before = { path, time: 'save-check', title: 'Save check', done: false, body: 'Before' };
	const saved = { ...before, body: 'Saved text' };
	let writeCount = 0;
	let readsFail = true;
	const transport = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (url: Parameters<typeof fetch>[0]) => {
				if (String(url).endsWith('/get')) {
					if (readsFail) return new Response('read unavailable', { status: 503 });
				} else writeCount++;
				return new Response(JSON.stringify({ answer: { returned: saved } }) + '\n');
			},
			{ preconnect: fetch.preconnect },
		),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _previous, _mutation, { client }) =>
				client.invalidateQueries(),
		}),
	});
	const options = reads.get({ path });
	client.setQueryData(options.queryKey, before);
	const view = new QueryObserver(client, { ...options, staleTime: Infinity });
	const stop = view.subscribe(() => {});
	try {
		const save = new MutationObserver(client, writes.note);
		await save.mutate({ path, body: saved.body });
		expect(save.getCurrentResult().status).toBe('success');
		expect(view.getCurrentResult().isRefetchError).toBe(true);
		expect(view.getCurrentResult().data?.body).toBe(saved.body);
		readsFail = false;
		await client.refetchQueries({ queryKey: options.queryKey, exact: true });
		expect(view.getCurrentResult().isRefetchError).toBe(false);
		expect(view.getCurrentResult().data?.body).toBe(saved.body);
		expect(writeCount).toBe(1);
	} finally {
		stop();
		client.clear();
		transport.mockRestore();
	}
});

/** Exact caches are reconciled once per confirmed write, before failed invalidation reads. */
const path = 'data/tasks/save-check.md';
const confirmed = { path, time: 'save-check', title: 'Save check', done: false, body: 'Notes', other: { extra: 'kept only in get' } };
const response = (returned: unknown) => new Response(JSON.stringify({ answer: { returned } }) + '\n');
function cacheClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _previous, _mutation, { client }) => client.invalidateQueries(),
		}),
	});
}

for (const loaded of [true, false]) test(`add reconciles a ${loaded ? 'loaded empty' : 'missing'} list`, async () => {
	const client = cacheClient();
	const listKey = reads.list().queryKey;
	if (loaded) client.setQueryData(listKey, []);
	const view = loaded ? new QueryObserver(client, { ...reads.list(), staleTime: Infinity }) : undefined;
	const stop = view?.subscribe(() => {});
	let writesMade = 0;
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0]) => {
		if (String(url).endsWith('/add')) { writesMade++; return response(confirmed); }
		return new Response('read unavailable', { status: 503 });
	}, { preconnect: fetch.preconnect }));
	try {
		await new MutationObserver(client, writes.add).mutate({ title: confirmed.title });
		const { body: _body, other: _other, ...row } = confirmed;
		expect(client.getQueryData(listKey)).toEqual(loaded ? [row] : undefined);
		if (view) expect(view.getCurrentResult().isRefetchError).toBe(true);
		expect(client.getQueryData(reads.get({ path }).queryKey)).toEqual(confirmed);
		await client.refetchQueries();
		expect(writesMade).toBe(1);
	} finally { stop?.(); client.clear(); transport.mockRestore(); }
});

for (const outcome of [true, false, 'failed'] as const) test(`delete ${outcome} reconciles only confirmed absence`, async () => {
	const client = cacheClient();
	const getKey = reads.get({ path }).queryKey;
	const listKey = reads.list().queryKey;
	const { body: _body, other: _other, ...row } = confirmed;
	const unrelated = { ...row, path: 'unrelated.md' };
	client.setQueryData(getKey, confirmed);
	client.setQueryData(listKey, [row, unrelated]);
	const view = new QueryObserver(client, { ...reads.list(), staleTime: Infinity });
	const stop = view.subscribe(() => {});
	let writesMade = 0;
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0]) => {
		if (String(url).endsWith('/delete')) {
			writesMade++;
			return outcome === 'failed' ? new Response('uncertain', { status: 503 }) : response(outcome);
		}
		return new Response('read unavailable', { status: 503 });
	}, { preconnect: fetch.preconnect }));
	try {
		const mutation = new MutationObserver(client, writes.delete);
		if (outcome === 'failed') await expect(mutation.mutate({ path })).rejects.toBeDefined();
		else await mutation.mutate({ path });
		expect(client.getQueryData(listKey)).toEqual(outcome === 'failed' ? [row, unrelated] : [unrelated]);
		expect(view.getCurrentResult().isRefetchError).toBe(true);
		expect(client.getQueryState(getKey)).toEqual(outcome === 'failed' ? expect.objectContaining({ data: confirmed }) : undefined);
		await client.refetchQueries();
		expect(writesMade).toBe(1);
	} finally { stop(); client.clear(); transport.mockRestore(); }
});
