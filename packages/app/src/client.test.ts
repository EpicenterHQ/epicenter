/**
 * A view's client asks serve to run an action and answers a Result: what it
 * returned, or which of serve's answers said why not. Wellcrafted's maps turn
 * those calls into TanStack options, and the view's one QueryClient refreshes
 * every read after any write.
 */
import { afterEach, expect, test } from 'bun:test';
import { MutationObserver, QueryObserver } from '@tanstack/query-core';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { changedElsewhere, connect, createQueryClient } from './client.ts';
import { defineApp, defineCollection, field } from './index.ts';

const books = defineCollection({
	path: 'books/{title}.md',
	fields: { rating: field.integer({ optional: true }) },
});

const reading = defineApp({
	description: 'Books',
	collections: { books },
	actions: { ...books.actions() },
});

const sent: { name: string; arguments: unknown }[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	sent.length = 0;
});

/** Answer every call with `structuredContent`, recording what was asked. */
function answer(content: (name: string) => unknown) {
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const { params } = JSON.parse(String(init.body));
		sent.push({ name: params.name, arguments: params.arguments });
		return Response.json({
			result: { structuredContent: content(params.name) },
		});
	}) as typeof fetch;
}

const app = connect<typeof reading>('reading');

test('a call asks for its MCP tool and answers what the action returned', async () => {
	answer(() => ({ returned: { path: 'books/Dune.md' } }));
	expect<unknown>(expectOk(await app.get({ path: 'books/Dune.md' }))).toEqual({
		path: 'books/Dune.md',
	});
	expect(sent).toEqual([
		{ name: 'reading_get', arguments: { path: 'books/Dune.md' } },
	]);
});

test('each way serve answers without a value is its own error', async () => {
	answer(() => ({
		threw: {
			message: 'books/Dune.md changed',
			thrown: {
				name: 'Changed',
				message: 'books/Dune.md changed',
				path: 'books/Dune.md',
			},
		},
	}));
	const threw = expectErr(
		await app.edit({ path: 'books/Dune.md', old: 'a', new: 'b' }),
	);
	expect(threw.name).toBe('Threw');
	expect(changedElsewhere(threw)).toBe(true);

	answer(() => ({
		error: { name: 'InputError', message: 'path is required', next: 'Give a path' },
	}));
	const refused = expectErr(await app.list());
	expect(refused).toMatchObject({
		name: 'Refused',
		message: 'path is required',
		next: 'Give a path',
	});
	expect(changedElsewhere(refused)).toBe(false);

	globalThis.fetch = (async () =>
		new Response('', {
			status: 502,
			statusText: 'Bad Gateway',
		})) as unknown as typeof fetch;
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Unreachable',
		message: 'Epicenter answered 502 Bad Gateway',
	});
});

test('every write refreshes every read the page shows, before the write is done', async () => {
	let lists = 0;
	answer((name) => ({
		returned: name === 'reading_list' ? [{ list: ++lists }] : true,
	}));
	const bookReads = resultQueries(['reading'], { list: app.list });
	const bookWrites = resultMutations(['reading'], { delete: app.delete });
	const client = createQueryClient();
	const stop = new QueryObserver(client, bookReads.list()).subscribe(() => {});
	try {
		await client.query(bookReads.list());
		expect<unknown>(client.getQueryData(bookReads.list().queryKey)).toEqual([
			{ list: 1 },
		]);
		await new MutationObserver(client, bookWrites.delete).mutate({
			path: 'books/Dune.md',
		});
		expect<unknown>(client.getQueryData(bookReads.list().queryKey)).toEqual([
			{ list: 2 },
		]);
	} finally {
		stop();
		client.clear();
	}
});
