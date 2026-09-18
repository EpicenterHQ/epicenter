import { defineApp, field } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';
import { createBrowserAuth } from '@epicenter/auth';
import { Ok } from 'wellcrafted/result';

import { createDeparture } from '../../src/boot-screens/departure.js';
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
Reflect.set(window, 'fetch', async () => {
	probe.events.push('candidate-verified');
	return Response.json({ principalId: 'instance' });
});
export const auth = createBrowserAuth({
	appId: 'probe',
	baseURL: 'https://hosted.example',
});
const definition = defineApp({
	id: 'test.boot-probe',
	kv: { text: field.string() },
	tables: {},
});
const runtime = createMemoryRuntime();
export const opening = new URL(location.href).searchParams.has('connect')
	? undefined
	: openApp(definition, {
			runtime: {
				...runtime,
				async data(...args) {
					const mode = new URL(location.href).searchParams.get('opening');
					if (mode === 'held') await probe.opening;
					if (mode === 'failed')
						throw new Error('Fixture storage is unavailable.');
					const result = await runtime.data(...args);
					if (result.error) return result;
					const backing = result.data;
					return Ok({
						...backing,
						durable: {
							...backing.durable,
							async commit(operations) {
								probe.events.push('commit-start');
								await probe.commit;
								await backing.durable.commit(operations);
								probe.events.push('commit-end');
							},
						},
					});
				},
			},
		}).then((app) => {
			app.device.kv.update({ text: 'accepted edit' });
			return app;
		});
export const departure = createDeparture({
	opening,
	account: auth.auth?.state.account,
	auth: opening ? (auth.auth ?? undefined) : undefined,
});
departure.onChange(() => {
	if (departure.state.phase === 'closed') probe.events.push('closed');
});
