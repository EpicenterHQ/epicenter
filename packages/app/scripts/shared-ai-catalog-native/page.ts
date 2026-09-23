import { openEndpointInference } from '@epicenter/app/ai';
import { openLocalConnectionCatalog } from '@epicenter/app/ai-connections';
import { createDesktopSqliteOwner } from '@epicenter/device/desktop';
import { unwrap } from 'wellcrafted/result';
import { createBrowserInferenceSelections } from '../../../app-shell/src/inference-selections.js';

// Installed acceptance applications, not product builds. The build selects the
// native catalog and an independent SQL namespace.
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
const catalog = await openLocalConnectionCatalog();
const sqlite = await createDesktopSqliteOwner().acquire(product);
const selections = createBrowserInferenceSelections(product);
let retained: ReturnType<(typeof catalog)['get']>;
let pending: Promise<string> | undefined;
let endpoint: Awaited<ReturnType<typeof openEndpointInference>> | undefined;
Object.assign(window, {
	acceptance: {
		documentId: crypto.randomUUID(),
		async unsaved(baseURL: string) {
			const client = await openEndpointInference({
				baseURL,
				getAuthHeaders: () => ({
					Authorization: 'Bearer callback-key',
					'cf-aig-authorization': 'Bearer gateway-key',
				}),
			});
			try {
				const completion = await client.client.chat.completions.create({
					model: 'manual',
					messages: [{ role: 'user', content: 'hello' }],
				});
				const transcript = await client.client.audio.transcriptions.create({
					model: 'manual',
					file: new File(['exact webview bytes'], 'audio.wav', {
						type: 'audio/wav',
					}),
				});
				return {
					text: completion.choices[0]!.message.content,
					transcript: transcript.text,
				};
			} finally {
				await client.close();
			}
		},
		async holdEndpoint(baseURL: string) {
			endpoint = await openEndpointInference({ baseURL });
			await endpoint.client.models.list().asResponse();
			return 'response-owned';
		},
		async closeEndpoint() {
			await endpoint!.close();
			return 'closed';
		},

		records: () => catalog.getAll().map(({ client: _, ...record }) => record),
		add: (input: Parameters<(typeof catalog)['add']>[0]) => catalog.add(input),
		update: (id: string, patch: Parameters<(typeof catalog)['update']>[1]) =>
			catalog.update(id, patch),
		remove: (id: string) => catalog.remove(id),
		select: (id: string) =>
			selections.set('chat', { connectionId: id, model: 'manual' }),
		selected: () => selections.get('chat'),
		retain(id: string) {
			retained = catalog.get(id);
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
			return (await catalog.get(id)!.client.models.list()).data;
		},
		start(id: string) {
			pending = catalog
				.get(id)!
				.client.models.list()
				.then(
					() => 'sent',
					() => 'rejected',
				);
		},
		async close() {
			selections[Symbol.dispose]();
			await Promise.all([catalog.close(), sqlite.close()]);
			return pending ? await pending : 'closed';
		},
		async leaveSqlOpen() {
			const database = await sqlite.open('teardown-proof');
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
			const database = await sqlite.open('teardown-proof');
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
