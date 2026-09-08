import { expect, test } from 'bun:test';
import { createDesktopDevice } from './desktop.js';
import { secretLabel } from './index.js';
import type { DeviceRequest } from './protocol.js';

function ownerFor(answer: (request: DeviceRequest) => Response): {
	calls: DeviceRequest[];
	fetch: typeof globalThis.fetch;
} {
	const calls: DeviceRequest[] = [];
	const fetchImplementation = (async (_url: string, init?: RequestInit) => {
		const request = JSON.parse(String(init?.body)) as DeviceRequest;
		calls.push(request);
		return answer(request);
	}) as unknown as typeof globalThis.fetch;
	return { calls, fetch: fetchImplementation };
}

test('statements and secrets reach the owner scoped by application', async () => {
	const owner = ownerFor((request) => {
		if (request.kind === 'sqlite-all') {
			return Response.json({ kind: 'sqlite-all', rows: [{ id: 'one' }] });
		}
		if (request.kind === 'secret-get') {
			return Response.json({ kind: 'secret-get', value: 'refresh' });
		}
		return Response.json({ kind: request.kind });
	});
	const storage = createDesktopDevice({
		appId: 'so.epicenter.test',
		baseURL: 'http://127.0.0.1:1',
		fetch: owner.fetch,
	});

	const sqlite = await storage.sqlite.open('mail');
	if (sqlite.error !== null) throw sqlite.error;
	const rows = await sqlite.data.all('SELECT id FROM messages');
	expect(rows.data).toEqual([{ id: 'one' }]);

	await storage.secrets.put(secretLabel('account-1'), 'refresh');
	const secret = await storage.secrets.get(secretLabel('account-1'));
	expect(secret.data).toBe('refresh');

	expect(owner.calls.map((call) => call.kind)).toEqual([
		'sqlite-all',
		'secret-put',
		'secret-get',
	]);
	expect(owner.calls.every((call) => call.appId === 'so.epicenter.test')).toBe(
		true,
	);
});
