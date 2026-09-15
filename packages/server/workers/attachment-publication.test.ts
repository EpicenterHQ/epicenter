/**
 * Attachment publication through the deployed Hono mount and named authority.
 * The byte GET is mocked, but signing, hashing, SQLite publication, authentication,
 * eviction and generation retirement run in workerd through production code.
 */
import {
	env,
	SELF,
	evictDurableObject,
	runInDurableObject,
} from 'cloudflare:test';
import { openCurrentAuthority } from '@epicenter/data/sync';
import { attachmentStorageId } from '@epicenter/blobs';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { ATTACHMENT_ROUTE } from '@epicenter/sync/attachment-route';
import { expect, onTestFinished, test, vi } from 'vitest';

async function setup() {
	const principal = `attachments-${crypto.randomUUID()}`;
	const appId = 'com.epicenter.whispering';
	const dataId = appId;
	const name = `libraries/apps/${appId}/personal/${principal}/data/${dataId}`;
	const stub = env.STORE_AUTHORITY.get(env.STORE_AUTHORITY.idFromName(name));
	const base = `https://worker.test/api/libraries/${appId}/personal/data/${dataId}`;
	const headers = { authorization: `Bearer device:${principal}` };
	const initialized = await SELF.fetch(`${base}/current`, {
		method: 'POST',
		headers,
		body: new Uint8Array([1]),
	});
	expect(initialized.status).toBe(200);
	await initialized.arrayBuffer();
	const url = ATTACHMENT_ROUTE.url(
		'https://worker.test',
		appId,
		'personal',
		dataId,
		'recordings',
		'aaaaaaaaaaaaaaaaaaaaaaaa',
	);
	const content = {
		sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		size: 3,
		contentType: 'audio/wav',
	};
	const control = JSON.stringify({ generation: 1, content });
	return { stub, name, url, headers, content, control };
}

test('authenticated tickets use the named authority scope and verified retries survive eviction', async () => {
	const fetcher = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(
			async () =>
				new Response('abc', { headers: { 'content-type': 'audio/wav' } }),
		);
	onTestFinished(() => fetcher.mockRestore());
	const { stub, name, url, headers, content, control } = await setup();
	const response = await SELF.fetch(url, {
		method: 'POST',
		headers,
		body: control,
	});
	expect(response.status).toBe(200);
	const ticket = (await response.json()) as {
		url: string;
		requiredHeaders: Record<string, string>;
	};
	expect(new URL(ticket.url).pathname).toBe(
		`/test-bucket/${name}/attachments/recordings/aaaaaaaaaaaaaaaaaaaaaaaa`,
	);
	expect(ticket.requiredHeaders['if-none-match']).toBe('*');
	expect(ticket.requiredHeaders['x-amz-checksum-sha256']).toBe(
		'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
	);
	expect(
		(await SELF.fetch(url, { method: 'PUT', headers, body: control })).status,
	).toBe(204);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe(
		new URL(ticket.url).pathname,
	);
	await evictDurableObject(stub);
	// An identical retry uses retained proof without another byte GET.
	expect(
		(await SELF.fetch(url, { method: 'PUT', headers, body: control })).status,
	).toBe(204);
	expect(fetcher).toHaveBeenCalledTimes(1);
	const manifest = await SELF.fetch(`${url}?generation=1`, { headers });
	expect(manifest.status).toBe(200);
	expect(await manifest.json()).toMatchObject({ content });
	const other = await SELF.fetch(`${url}?generation=1`, {
		headers: { authorization: 'Bearer device:another-person' },
	});
	expect(other.status).toBe(410);
});

test('retirement rejects old tickets and the replacement can read immutable publication', async () => {
	const { stub, url, headers, content, control } = await setup();
	await runInDurableObject(stub, async (_instance, state) => {
		const authority = openCurrentAuthority({
			sqlite: createDurableObjectSqliteAdapter(
				state.storage as unknown as DurableObjectSqliteStorage,
			),
		});
		expect(
			authority.attachments.publish(
				1,
				attachmentStorageId('recordings', 'aaaaaaaaaaaaaaaaaaaaaaaa'),
				content,
			),
		).toBe('accepted');
		const { generation, head } = authority.capture();
		const prepared = await authority.prepareActivation({
			operation: crypto.randomUUID(),
			expected: { generation, head },
			bytes: new Uint8Array([2]),
		});
		expect(prepared.activate().status).toBe('activated');
	});
	await evictDurableObject(stub);
	for (const method of ['POST', 'PUT'])
		expect(
			(await SELF.fetch(url, { method, headers, body: control })).status,
		).toBe(410);
	expect((await SELF.fetch(`${url}?generation=1`, { headers })).status).toBe(
		410,
	);
	const current = await SELF.fetch(`${url}?generation=2`, { headers });
	expect(current.status).toBe(200);
	expect(await current.json()).toMatchObject({ content });
});

test('retirement while the byte GET is pending refuses late verified publication', async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		await pending;
		return new Response('abc', { headers: { 'content-type': 'audio/wav' } });
	});
	onTestFinished(() => {
		release();
		fetcher.mockRestore();
	});
	const { stub, url, headers, control } = await setup();
	const publication = SELF.fetch(url, {
		method: 'PUT',
		headers,
		body: control,
	});
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
	await runInDurableObject(stub, async (_instance, state) => {
		const authority = openCurrentAuthority({
			sqlite: createDurableObjectSqliteAdapter(
				state.storage as unknown as DurableObjectSqliteStorage,
			),
		});
		const { generation, head } = authority.capture();
		const prepared = await authority.prepareActivation({
			operation: crypto.randomUUID(),
			expected: { generation, head },
			bytes: new Uint8Array([2]),
		});
		expect(prepared.activate().status).toBe('activated');
	});
	release();
	const refused = await publication;
	expect(refused.status).toBe(410);
	expect(await refused.text()).toBe('retired');
	await evictDurableObject(stub);
	expect((await SELF.fetch(`${url}?generation=2`, { headers })).status).toBe(
		404,
	);
});

test('missing bearer, forged owner, Local and malformed paths cannot reach publication', async () => {
	const { stub, url, headers, control } = await setup();
	expect(
		(await SELF.fetch(url, { method: 'POST', body: control })).status,
	).toBe(401);
	for (const query of ['?owner=another', '?principalId=another'])
		expect(
			(
				await SELF.fetch(url + query, {
					method: 'POST',
					headers,
					body: control,
				})
			).status,
		).toBe(403);
	expect(
		(
			await SELF.fetch(url.replace('/personal/', '/local/'), {
				method: 'POST',
				headers,
				body: control,
			})
		).status,
	).toBe(403);
	expect(
		(await stub.fetch(url + '/extra', { method: 'POST', body: control }))
			.status,
	).toBe(400);
	expect(
		(
			await stub.fetch(url.replace('aaaaaaaaaaaaaaaaaaaaaaaa', '%GG'), {
				method: 'POST',
				body: control,
			})
		).status,
	).toBe(400);
	const unnamed = env.STORE_AUTHORITY.get(env.STORE_AUTHORITY.newUniqueId());
	expect(
		(await unnamed.fetch(url, { method: 'POST', body: control })).status,
	).toBe(503);
	const baseline = await unnamed.fetch(
		'https://authority.test/api/libraries/so.epicenter.test/personal/data/attachments.example/current',
		{ method: 'POST', body: new Uint8Array([1]) },
	);
	expect(baseline.status).toBe(200);
	await baseline.arrayBuffer();
});
