import { defineApp, field } from '@epicenter/app';
import { createMemoryRuntime } from '@epicenter/app/testing';
import { createBrowserAuth } from '@epicenter/auth';
import { createCurrentDownloadResponse } from '../../../sync/src/current-download.js';
import { Ok } from 'wellcrafted/result';

import { probe } from './probe.js';

const local =
	new URL(location.href).searchParams.has('local') ||
	sessionStorage.getItem('local') === 'true';
sessionStorage.setItem('local', String(local));
if (!local && !localStorage.getItem('probe.auth.server')) {
	localStorage.setItem('probe.auth.server', 'https://old.example');
	localStorage.setItem(
		'probe.auth.instance:https://old.example',
		JSON.stringify({ token: 'old', principalId: 'instance' }),
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
		if (new URL(request.url).hostname === 'next.example')
			probe.events.push('candidate-verified');
		return Response.json({ principalId: 'instance' });
	},
);
export const auth = createBrowserAuth({
	appId: 'probe',
	baseURL: 'https://hosted.example',
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
