/** Atomic local publication and HTTP lifecycle through the Personal authority. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import { openLocalBlobStore } from './local-blob-store.js';
import { mountPersonalAuthorityBlobs } from './routes/authority-blobs.js';
import type { Env } from './types.js';

test('local publication, media reads, access, ranges, deletion, and reopening', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-local-blobs-'));
	const path = join(root, 'blobs.sqlite');
	let opened = openLocalBlobStore(path);
	const origin = 'https://authority.test';
	let actor: string | null = 'alice';
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('authBaseURL', origin);
		await next();
	});
	mountPersonalAuthorityBlobs(app, {
		resolveStore: () => opened.store,
		auth: async (c, next) => {
			if (!actor) return c.text('Unauthorized', 401);
			c.set('principal', { id: asPrincipalId(actor) });
			await next();
		},
	});
	const request = (url: string, init?: RequestInit) => app.request(url, init);
	try {
		const bytes = new Uint8Array([0, 1, 2, 3, 255]);
		const publish = await request(`${origin}/api/blobs/personal/alice/public`, {
			method: 'POST',
			headers: { 'content-type': 'audio/webm' },
			body: bytes,
		});
		expect(publish.status).toBe(201);
		const { url } = await publish.json<{ url: string }>();
		actor = null;
		const media = await request(url);
		expect(media.status).toBe(200);
		expect(media.headers.get('content-disposition')).toBe('inline');
		expect(new Uint8Array(await media.arrayBuffer())).toEqual(bytes);
		const head = await request(url, { method: 'HEAD' });
		expect(head.headers.get('content-length')).toBe('5');
		expect(await head.text()).toBe('');
		const range = await request(url, {
			headers: { range: 'bytes=2-3', 'if-range': media.headers.get('etag')! },
		});
		expect(range.status).toBe(206);
		expect(range.headers.get('content-range')).toBe('bytes 2-3/5');
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(
			new Uint8Array([2, 3]),
		);
		expect(
			(await request(url, { headers: { 'if-match': '"wrong"' } })).status,
		).toBe(412);
		expect(
			(await request(url, { headers: { range: 'bytes=6-' } })).status,
		).toBe(416);
		const key = new URL(url).pathname.slice('/api/blobs/'.length);
		expect(await opened.store.put(key, new Blob(['replacement']))).toBe(
			'conflict',
		);
		opened.close();
		opened = openLocalBlobStore(path);
		expect(new Uint8Array(await (await request(url)).arrayBuffer())).toEqual(
			bytes,
		);
		actor = 'bob';
		expect((await request(url, { method: 'DELETE' })).status).toBe(403);
		actor = 'alice';
		expect((await request(url, { method: 'DELETE' })).status).toBe(204);
		expect((await request(url)).status).toBe(404);
		const privatePublish = await request(
			`${origin}/api/blobs/personal/alice/private`,
			{ method: 'POST', body: bytes },
		);
		const privateUrl = (await privatePublish.json<{ url: string }>()).url;
		actor = null;
		expect((await request(privateUrl)).status).toBe(401);
		actor = 'bob';
		expect((await request(privateUrl)).status).toBe(403);
		actor = 'alice';
		expect(
			new Uint8Array(await (await request(privateUrl)).arrayBuffer()),
		).toEqual(bytes);
	} finally {
		opened.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an interrupted SQLite publication exposes no partial object', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-interrupted-blobs-'));
	const path = join(root, 'blobs.sqlite');
	const opened = openLocalBlobStore(path);
	const database = new Database(path);
	try {
		expect(() =>
			database
				.transaction(() => {
					database
						.prepare(
							'INSERT INTO blobs (key, bytes, content_type, etag, modified) VALUES (?, ?, ?, ?, ?)',
						)
						.run(
							'interrupted',
							new Uint8Array([1, 2]),
							'audio/wav',
							'"x"',
							new Date().toUTCString(),
						);
					throw new Error('interrupted before commit');
				})
				.immediate(),
		).toThrow('interrupted before commit');
		expect(await opened.store.head('interrupted')).toBeNull();
		expect(
			await opened.store.put('interrupted', new Blob([new Uint8Array([3])])),
		).toBe('created');
		expect(await opened.store.read('interrupted', 0, 0, '')).toEqual(
			new Uint8Array([3]),
		);
	} finally {
		database.close();
		opened.close();
		rmSync(root, { recursive: true, force: true });
	}
});
