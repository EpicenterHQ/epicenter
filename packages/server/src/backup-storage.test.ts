/**
 * The real S3 signer/archive adapter and generic DELETE route against a local
 * HTTP object fixture. Verifies namespace isolation and conditional-write headers,
 * not a hosted provider's signature enforcement or power-loss retention.
 */
import { expect, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createS3ArchiveStore } from './backup-storage.js';
import { libraryStoragePrefix } from './library.js';
import { mountBlobsApp } from './routes/blobs.js';
import { createS3BlobStore } from './s3-blob-store.js';
import type { Env } from './types.js';

test('generic blob deletion cannot delete or overwrite an immutable recovery object with the same id', async () => {
	const objects = new Map<string, Blob>();
	const conditional: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const key = new URL(request.url).pathname;
			if (request.method === 'PUT') {
				conditional.push(request.headers.get('if-none-match') ?? '');
				if (objects.has(key)) return new Response(null, { status: 412 });
				objects.set(
					key,
					new Blob([await request.arrayBuffer()], {
						type: request.headers.get('content-type') ?? '',
					}),
				);
				return new Response(null, { status: 200 });
			}
			if (request.method === 'DELETE') {
				objects.delete(key);
				return new Response(null, { status: 204 });
			}
			const value = objects.get(key);
			return value
				? new Response(value, { headers: { 'content-type': value.type } })
				: new Response(null, { status: 404 });
		},
	});
	try {
		const endpoint = server.url.origin;
		const prefix = libraryStoragePrefix(
			'so.epicenter.notes',
			'personal',
			asPrincipalId('alice'),
		);
		const library = `${prefix}/data/so.epicenter.notes`;
		const store = createS3BlobStore({
			endpoint,
			region: 'auto',
			bucket: 'epicenter-blobs',
			accessKeyId: 'test',
			secretAccessKey: 'test',
		});
		const archives = createS3ArchiveStore({ store, library });
		const id = generateBlobId('json');
		const bytes = new Blob(['  exact original\n'], {
			type: 'application/json;charset=utf-8',
		});
		expectOk(await archives.put(id, bytes));
		expect(expectErr(await archives.put(id, new Blob(['changed']))).name).toBe(
			'BlobAlreadyExists',
		);
		expect(conditional).toEqual(['*', '*']);
		const app = new Hono<Env>();
		mountBlobsApp(app, {
			auth: async (c, next) => {
				c.set('principal', { id: asPrincipalId('alice') });
				c.set('authBaseURL', 'https://api.test');
				await next();
			},
		});
		const response = await app.request(
			`https://api.test/api/apps/so.epicenter.notes/principals/alice/blobs/${id}`,
			{ method: 'DELETE' },
			{
				BLOBS_S3_ENDPOINT: endpoint,
				BLOBS_S3_ACCESS_KEY_ID: 'test',
				BLOBS_S3_SECRET_ACCESS_KEY: 'test',
			},
		);
		expect(response.status).toBe(204);
		const saved = expectOk(await archives.get(id));
		expect(await saved.text()).toBe(await bytes.text());
		expect(saved.type).toBe(bytes.type);
		const other = createS3ArchiveStore({
			store,
			library: library.replace('alice', 'bob'),
		});
		expect(expectErr(await other.get(id)).name).toBe('BlobNotFound');
		expect([...objects.keys()]).toEqual([
			`/epicenter-blobs/${library}/backups/${id}`,
		]);
	} finally {
		await server.stop(true);
	}
});
