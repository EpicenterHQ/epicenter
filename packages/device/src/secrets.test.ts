/**
 * Scoped secret storage tests.
 * App, authority, principal and label boundaries isolate credentials. Browser
 * handles recover values within a document, and desktop requests capture identity.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectOk } from 'wellcrafted/testing';
import { createBrowserSecrets } from './browser.js';
import { createDesktopSecrets } from './desktop.js';
import { secretLabel } from './index.js';

const label = secretLabel('token');

test('browser secrets survive reopening and deletion affects only one full scope', async () => {
	const appId = 'so.epicenter.secret-test';
	const identities = [
		null,
		{ authorityId: 'a:b', principalId: asPrincipalId('c') },
		{ authorityId: 'a', principalId: asPrincipalId('b:c') },
		{ authorityId: 'a', principalId: asPrincipalId('c') },
	];
	for (const [index, account] of identities.entries()) {
		expectOk(
			await createBrowserSecrets(appId, account).value.put(
				label,
				String(index),
			),
		);
	}
	const otherApp = createBrowserSecrets(
		'so.epicenter.secret-other',
		identities[1]!,
	);
	expect(expectOk(await otherApp.value.get(label))).toBeNull();
	expectOk(await otherApp.value.put(label, 'other-app'));
	for (const [index, account] of identities.entries()) {
		expect(
			expectOk(await createBrowserSecrets(appId, account).value.get(label)),
		).toBe(String(index));
	}
	expectOk(
		await createBrowserSecrets(appId, identities[1]!).value.delete(label),
	);
	expect(
		expectOk(
			await createBrowserSecrets(appId, identities[1]!).value.get(label),
		),
	).toBeNull();
	expect(
		expectOk(
			await createBrowserSecrets(appId, identities[2]!).value.get(label),
		),
	).toBe('2');
	expect(expectOk(await otherApp.value.get(label))).toBe('other-app');
});

test('desktop sends captured structured account and independent labels for every verb', async () => {
	const account = {
		authorityId: 'server:a',
		principalId: asPrincipalId('person:b'),
		baseURL: 'https://private-transport.test',
		fetch: () => {
			throw new Error('No transport should be serialized.');
		},
	};
	const original = {
		authorityId: account.authorityId,
		principalId: account.principalId,
	};
	const requests: unknown[] = [];
	const secrets = createDesktopSecrets('so.epicenter.mail', account, {
		baseURL: 'https://epicenter.test',
		fetch: (async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			requests.push(request);
			return Response.json({ kind: request.kind, value: 'credential' });
		}) as typeof fetch,
	});
	account.authorityId = 'changed';
	expectOk(await secrets.value.put(label, 'credential'));
	expect(expectOk(await secrets.value.get(label))).toBe('credential');
	expectOk(await secrets.value.delete(label));
	expect(requests).toEqual([
		{
			kind: 'secret-put',
			appId: 'so.epicenter.mail',
			account: original,
			label,
			value: 'credential',
		},
		{
			kind: 'secret-get',
			appId: 'so.epicenter.mail',
			account: original,
			label,
		},
		{
			kind: 'secret-delete',
			appId: 'so.epicenter.mail',
			account: original,
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
	const secrets = create('so.epicenter.secret-lifetime', null, options);
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
				await createBrowserSecrets(
					'so.epicenter.secret-lifetime',
					null,
				).value.get(label),
			),
		).toBe('saved');
	else expect(requests).toBe(1);
});

test('desktop close drains a write even when fetch calls close reentrantly', async () => {
	const response = Promise.withResolvers<Response>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const secrets = createDesktopSecrets('so.epicenter.secret-drain', null, {
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
