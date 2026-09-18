import { defineApp } from '@epicenter/app';
import { openApp } from '@epicenter/app/open';
import { unwrap } from 'wellcrafted/result';
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
							name: 'Unadopted fixture',
							baseUrl: 'http://127.0.0.1:1/v1',
							models: ['manual'],
						},
					]
				: [],
		}),
	);
	localStorage.setItem(`${product}.seeded`, 'yes');
}
const app = await openApp(defineApp({ tables: {}, kv: {}, id: product }));
const selections = createBrowserInferenceSelections(product);
let retained: ReturnType<
	NonNullable<typeof app.device.connections.custom>['get']
>;
let pending: Promise<string> | undefined;
Object.assign(window, {
	acceptance: {
		documentId: crypto.randomUUID(),
		records: () =>
			app.device.connections
				.custom!.getAll()
				.map(({ client: _, ...record }) => record),
		add: (
			input: Parameters<
				NonNullable<typeof app.device.connections.custom>['add']
			>[0],
		) => app.device.connections.custom!.add(input),
		update: (
			id: string,
			patch: Parameters<
				NonNullable<typeof app.device.connections.custom>['update']
			>[1],
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
			return (
				await app.device.connections.custom!.get(id)!.client.models.list()
			).data;
		},
		start(id: string) {
			pending = app.device.connections
				.custom!.get(id)!
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
		async leaveSqlOpen() {
			const database = unwrap(await app.device.sqlite.open('teardown-proof'));
			unwrap(
				await database.run('CREATE TABLE IF NOT EXISTS persisted (value TEXT)'),
			);
			unwrap(await database.run('DELETE FROM persisted'));
			unwrap(
				await database.run('CREATE TEMP TABLE old_connection (value TEXT)'),
			);
			unwrap(await database.run('BEGIN'));
			unwrap(
				await database.run("INSERT INTO persisted VALUES ('uncommitted')"),
			);
			return 'held';
		},
		async verifySqlTeardown() {
			const database = unwrap(await app.device.sqlite.open('teardown-proof'));
			const rows = unwrap(await database.all('SELECT value FROM persisted'));
			const temporary = unwrap(
				await database.all(
					"SELECT name FROM sqlite_temp_master WHERE name = 'old_connection'",
				),
			);
			return { rows, temporary };
		},
		violations: () => violations,
	},
});
document.body.textContent = `${product}: ready`;
