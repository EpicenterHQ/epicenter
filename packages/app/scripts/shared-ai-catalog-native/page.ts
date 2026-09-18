import { defineApplication } from '@epicenter/app';
import { defineData } from '@epicenter/data/definition';
import { createBrowserInferenceSelections } from '../../../app-shell/src/inference-selections.js';

// Installed acceptance applications, not product builds. The build selects the
// default epicenter-host AI binding and opens a complete Local App.
const product = location.pathname.split('/')[2]!;
const violations: {
	directive: string;
	blocked: string;
	source: string;
	line: number;
}[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
	violations.push({
		directive: event.violatedDirective,
		blocked: event.blockedURI,
		source: event.sourceFile,
		line: event.lineNumber,
	});
});
await (window as unknown as { __EPICENTER_SESSION_READY__: Promise<void> })
	.__EPICENTER_SESSION_READY__;
if (!localStorage.getItem(`${product}.seeded`)) {
	localStorage.setItem(
		`${product}.app-ai-connections`,
		JSON.stringify({
			version: 1,
			connections: product.endsWith('-a')
				? [
						{
							id: 'native-legacy',
							name: 'Imported fixture',
							baseUrl: 'http://127.0.0.1:1/v1',
							models: ['manual'],
						},
					]
				: [],
		}),
	);
	localStorage.setItem(`${product}.seeded`, 'yes');
}
const app = defineApplication({
	appId: product,
	definition: defineData({ id: product, tables: {}, kv: {} }),
}).open(null);
const selections = createBrowserInferenceSelections(product);
let retained: ReturnType<NonNullable<typeof app.device.connections.custom>['get']>;
let pending: Promise<string> | undefined;
const ready = app.ready.then((result) => {
	if (result.error) throw new Error(JSON.stringify(result.error));
});
Object.assign(window, {
	acceptance: {
		ready,
		documentId: crypto.randomUUID(),
		records: () =>
			app.device.connections.custom!.getAll().map(({ client: _, ...record }) => record),
		add: (
			input: Parameters<NonNullable<typeof app.device.connections.custom>['add']>[0],
		) => app.device.connections.custom!.add(input),
		update: (
			id: string,
			patch: Parameters<NonNullable<typeof app.device.connections.custom>['update']>[1],
		) => app.device.connections.custom!.update(id, patch),
		remove: (id: string) => app.device.connections.custom!.remove(id),
		select: (id: string) =>
			selections.set('chat', { connectionId: id, model: 'manual' }),
		selected: () => selections.get('chat'),
		retain(id: string) {
			retained = app.device.connections.custom!.get(id);
		},
		async retained() {
			try {
				await retained!.client.models.list();
				return 'sent';
			} catch {
				return 'rejected';
			}
		},
		async run(id: string) {
			return (await app.device.connections.custom!.get(id)!.client.models.list()).data;
		},
		start(id: string) {
			pending = app.device.connections.custom!.get(id)!
				.client.models.list()
				.then(
					() => 'sent',
					() => 'rejected',
				);
		},
		async close() {
			selections[Symbol.dispose]();
			await app.close();
			return pending ? await pending : 'closed';
		},
		violations: () => violations,
	},
});
await ready;
document.body.textContent = `${product}: ready`;
