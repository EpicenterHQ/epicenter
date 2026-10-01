/**
 * Scoped secret storage tests.
 * App and label boundaries isolate credentials. Browser
 * handles recover values within a document, and desktop requests capture identity.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createBrowserSecrets } from './browser.js';
import { createDesktopSecrets } from './desktop.js';
import { secretLabel } from './index.js';

const label = secretLabel('token');

test('browser secrets survive reopening and isolate applications and labels', async () => {
	const appId = 'so.epicenter.secret-test';
	const first = createBrowserSecrets(appId);
	expectOk(await first.value.put(label, 'saved'));
	expectOk(await first.value.put(secretLabel('other'), 'other-label'));
	await first.close();
	const reopened = createBrowserSecrets(appId);
	const other = createBrowserSecrets('so.epicenter.secret-other');
	expect(expectOk(await reopened.value.get(label))).toBe('saved');
	expect(expectOk(await other.value.get(label))).toBeNull();
	expectOk(await reopened.value.delete(label));
	expect(expectOk(await reopened.value.get(label))).toBeNull();
	expect(expectOk(await reopened.value.get(secretLabel('other')))).toBe(
		'other-label',
	);
});

test('desktop sends only app and label for every secret verb', async () => {
	const requests: unknown[] = [];
	const secrets = createDesktopSecrets('so.epicenter.mail', {
		baseURL: 'https://epicenter.test',
		fetch: (async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			requests.push(request);
			return Response.json({ kind: request.kind, value: 'credential' });
		}) as typeof fetch,
	});
	expectOk(await secrets.value.put(label, 'credential'));
	expect(expectOk(await secrets.value.get(label))).toBe('credential');
	expectOk(await secrets.value.delete(label));
	expect(requests).toEqual([
		{
			kind: 'secret-put',
			appId: 'so.epicenter.mail',
			label,
			value: 'credential',
		},
		{
			kind: 'secret-get',
			appId: 'so.epicenter.mail',
			label,
		},
		{
			kind: 'secret-delete',
			appId: 'so.epicenter.mail',
			label,
		},
	]);
});

test.each([
	'browser',
	'desktop',
] as const)('%s secret methods check readiness and retained methods refuse closed use', async (platform) => {
	let ready = false;
	let requests = 0;
	const options = {
		assertUsable() {
			if (!ready) throw new Error('App is not ready.');
		},
		baseURL: 'https://epicenter.test',
		fetch: (async (_url) => {
			requests++;
			return Response.json({ kind: 'secret-put' });
		}) as typeof fetch,
	};
	const create =
		platform === 'browser' ? createBrowserSecrets : createDesktopSecrets;
	const secrets = create('so.epicenter.secret-lifetime', options);
	const { put, get, delete: remove } = secrets.value;
	for (const invoke of [
		() => put(label, 'saved'),
		() => get(label),
		() => remove(label),
	])
		expect(invoke).toThrow('not ready');
	expect(requests).toBe(0);
	ready = true;
	expectOk(await put(label, 'saved'));
	const closing = secrets.close();
	expect(secrets.close()).toBe(closing);
	await closing;
	for (const invoke of [
		() => put(label, 'late'),
		() => get(label),
		() => remove(label),
	])
		expect(invoke).toThrow('closed');
	if (platform === 'browser')
		expect(
			expectOk(
				await createBrowserSecrets('so.epicenter.secret-lifetime').value.get(
					label,
				),
			),
		).toBe('saved');
	else expect(requests).toBe(1);
});

test('desktop close drains a write even when fetch calls close reentrantly', async () => {
	const response = Promise.withResolvers<Response>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const secrets = createDesktopSecrets('so.epicenter.secret-drain', {
		baseURL: 'https://epicenter.test',
		fetch: ((_url) => {
			closing = secrets.close();
			void closing.then(() => {
				closed = true;
			});
			return response.promise;
		}) as typeof fetch,
	});
	const writing = secrets.value.put(label, 'durable');
	expect(closing).toBe(secrets.close());
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(() => secrets.value.get(label)).toThrow('closed');
	response.resolve(Response.json({ kind: 'secret-put' }));
	expectOk(await writing);
	await closing;
	expect(closed).toBe(true);
});
