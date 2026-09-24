/**
 * The actual self-host Worker stores and serves generation bytes through real
 * Durable Objects in workerd. Rotating its operator token rejects the previous
 * credential while preserving the one instance partition and its existing data.
 */
/// <reference path="../../../apps/self-host/worker-configuration.d.ts" />

import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import app from '../../../apps/self-host/worker/index.js';

test('operator token rotation preserves generation bytes in the instance partition', async () => {
	const origin = 'https://instance.example.test';
	const originalToken = `original-${'Q7r3Vm9pX2'.repeat(4)}`;
	const rotatedToken = `rotated-${'H8k4Nw6cZ1'.repeat(4)}`;
	const bindings = {
		...env,
		API_PUBLIC_ORIGIN: origin,
		TRUSTED_BROWSER_ORIGINS: '',
		INSTANCE_TOKEN: originalToken,
	};
	const dataId = `so.epicenter.instanceprobe-${crypto.randomUUID()}`;
	const collection = `/api/data/v1/${dataId}/generations`;
	const bytes = Uint8Array.from([0, 255, 17, 128, 42, 7]);
	function request(token: string, path: string, init?: RequestInit) {
		return app.fetch(
			new Request(`${origin}${path}`, {
				...init,
				headers: { authorization: `Bearer ${token}` },
			}),
			bindings,
		);
	}

	const created = await request(originalToken, collection, {
		method: 'POST',
		body: bytes.buffer,
	});
	expect(created.status).toBe(200);
	expect(await created.json()).toEqual({ generation: 1, position: 1 });
	const imported = await request(originalToken, `${collection}/1`);
	expect(imported.status).toBe(200);
	expect(new Uint8Array(await imported.arrayBuffer())).toEqual(bytes);

	bindings.INSTANCE_TOKEN = rotatedToken;
	const refusedRead = await request(originalToken, `${collection}/1`);
	expect(refusedRead.status).toBe(401);
	await refusedRead.body?.cancel();
	const refusedImport = await request(originalToken, collection, {
		method: 'POST',
		body: bytes.buffer,
	});
	expect(refusedImport.status).toBe(401);
	await refusedImport.body?.cancel();

	const listed = await request(rotatedToken, collection);
	expect(listed.status).toBe(200);
	expect(await listed.json()).toEqual({ generations: [1] });
	const restored = await request(
		rotatedToken,
		`${collection}/1?principalId=another-person`,
	);
	expect(restored.status).toBe(200);
	expect(restored.headers.get('epicenter-log-position')).toBe('1');
	expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
});
