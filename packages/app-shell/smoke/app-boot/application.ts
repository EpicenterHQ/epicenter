import { createBrowserAuth } from '@epicenter/auth';
import { compileData, defineData, field } from '@epicenter/data/definition';
import { Ok } from 'wellcrafted/result';
import { createStoreOverPort } from '../../../data/src/store/store.js';
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
const definition = compileData(
	defineData({
		id: 'test.boot-probe',
		kv: { text: field.string() },
		tables: {},
	}),
);
if (definition.error) throw definition.error;
export const app = new URL(location.href).searchParams.has('connect')
	? null
	: createStoreOverPort({
			definition: definition.data,
			acquire: async () => {
				const opening = new URL(location.href).searchParams.get('opening');
				if (opening === 'held') await probe.opening;
				if (opening === 'failed') throw new Error('Fixture storage is unavailable.');
				return Ok({
					durable: {
						async commit() {
							probe.events.push('commit-start');
							await probe.commit;
							probe.events.push('commit-end');
						},
					},
					loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				});
			},
		});
export const ready = app?.ready.then((result) => {
	if (result.error === null) app?.view.kv.update({ text: 'accepted edit' });
	return result;
});
export const departure = createDeparture({
	account: !auth.auth || auth.auth.state.status === 'signed-out' ? undefined : auth.auth.state.account,
	auth: app ? auth.auth ?? undefined : undefined,
	async close() {
		await app?.close();
		probe.events.push('closed');
	},
});
