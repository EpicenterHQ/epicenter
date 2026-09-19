import { defineApp, field } from '@epicenter/app';
import { createMemoryRuntime } from '@epicenter/app/testing';
import { createBrowserRedirectAuth, selfHostedServer } from '@epicenter/auth';
import { Ok } from 'wellcrafted/result';
import { createCurrentDownloadResponse } from '../../../sync/src/current-download.js';

import { probe } from './probe.js';

const local =
	new URL(location.href).searchParams.has('local') ||
	sessionStorage.getItem('local') === 'true';
sessionStorage.setItem('local', String(local));
if (!local && !sessionStorage.getItem('credential-seeded')) {
	sessionStorage.setItem('credential-seeded', 'true');
	localStorage.setItem(
		'probe.auth.persisted:https://old.example',
		JSON.stringify({ token: 'old', principalId: 'alice' }),
	);
}
Reflect.set(
	window,
	'fetch',
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		if (new URL(request.url).pathname.endsWith('/current')) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await request.arrayBuffer()),
				},
				tail: [],
			});
		}
		if (new URL(request.url).pathname === '/auth/sign-out')
			probe.events.push('signed-out');
		return Response.json({ principalId: 'alice' });
	},
);
export const auth = createBrowserRedirectAuth({
	appId: 'probe',
	server: selfHostedServer('https://old.example'),
});
export const definition = defineApp({
	id: 'test.boot-probe',
	kv: { text: field.string() },
	tables: {},
});
const memory = createMemoryRuntime();
export const runtime = {
	...memory,
	async claim(...args: Parameters<typeof memory.claim>) {
		const result = await memory.claim(...args);
		if (result.error) return result;
		return Ok({
			release() {
				result.data.release();
				probe.events.push('closed');
			},
		});
	},
	async data(...args: Parameters<typeof memory.data>) {
		const mode = new URL(location.href).searchParams.get('opening');
		if (mode === 'held') await probe.opening;
		if (mode === 'failed') throw new Error('Fixture storage is unavailable.');
		const result = await memory.data(...args);
		if (result.error) return result;
		const backing = result.data;
		return Ok({
			...backing,
			durable: {
				...backing.durable,
				async commit(operations: Parameters<typeof backing.durable.commit>[0]) {
					probe.events.push('commit-start');
					await probe.commit;
					await backing.durable.commit(operations);
					probe.events.push('commit-end');
				},
			},
		});
	},
};
