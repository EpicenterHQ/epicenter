import './style.css';
import { defineApp, defineTable, field } from '@epicenter/app';
import { syncEngineOf } from '@epicenter/app/direct';
import type { Account } from '@epicenter/auth';
import { mount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import { openLocalMailStorage } from '../../../src/storage.js';
import { mailDefinition } from '../../src/lib/data.js';
import { mail } from '../../src/lib/mail.js';
import { currentLibraryResponse } from '../current-library.js';
import { account, app } from './application.js';
import Panel from './Panel.svelte';

try {
	const ready = await app.ready;
	if (ready.error) throw ready.error;
	const storage = await openLocalMailStorage(app.device);
	if (localStorage.getItem('evidence-seeded') !== 'true') {
		for (const sub of ['one', 'two']) {
			expectOk(
				await storage.local.run(
					'INSERT OR IGNORE INTO accounts VALUES (?, ?, ?)',
					[sub, `${sub}@example.com`, '2026-09-09'],
				),
			);
			const cache = await storage.mail(sub);
			expectOk(
				await cache.run(
					'INSERT OR IGNORE INTO messages (id, resource, subject, synced_at) VALUES (?, ?, ?, ?)',
					[
						'same-message',
						JSON.stringify({
							snippet: `<script>throw 'unsafe'</script>`,
							internalDate: '1',
							labelIds: ['INBOX'],
						}),
						`${sub} subject`,
						'2026-09-09',
					],
				),
			);
		}
		localStorage.setItem('evidence-seeded', 'true');
	}
	const panel = mount(Panel, { target: document.getElementById('app')! });
	Object.assign(globalThis, {
		evidence: {
			app,
			mail,
			async close() {
				await mail.close();
				await app.close();
			},
			async remoteEdit(remove = false) {
				const peer = defineApp({ ...mailDefinition, id: app.appId }).open({
					...account,
					principalId: 'synthetic-peer' as Account['principalId'],
					fetch: (input, init) =>
						currentLibraryResponse(new Request(input, init)),
				});
				expectOk(await peer.ready);
				expectOk(
					syncEngineOf(peer.account!.personal).applyRemote(
						app.account!.personal.encodeStateSince(),
					),
				);
				const row = peer.account!.personal.tables.savedQueries.rows[0]!;
				if (remove) peer.account!.personal.tables.savedQueries.delete(row.id);
				else
					expectOk(
						peer.account!.personal.tables.savedQueries.update(row.id, {
							sql: 'SELECT id FROM labels',
						}),
					);
				expectOk(
					syncEngineOf(app.account!.personal).applyRemote(
						peer.account!.personal.encodeStateSince(),
					),
				);
				await app.account!.personal.persistence.flush();
				await peer.close();
			},
			async malformed() {
				const peer = defineApp({
					kv: {},
					tables: {
						savedQueries: defineTable({
							name: field.string(),
							sql: field.boolean(),
						}),
					},
					id: app.appId,
				}).open({
					...account,
					principalId: 'synthetic-malformed' as Account['principalId'],
					fetch: (input, init) =>
						currentLibraryResponse(new Request(input, init)),
				});
				expectOk(await peer.ready);
				const repair = peer.account!.personal.tables.savedQueries.create({
					name: 'Repair fixture',
					sql: false,
				});
				const remove = peer.account!.personal.tables.savedQueries.create({
					name: 'Delete fixture',
					sql: true,
				});
				expectOk(
					syncEngineOf(app.account!.personal).applyRemote(
						peer.account!.personal.encodeStateSince(),
					),
				);
				await app.account!.personal.persistence.flush();
				await peer.close();
				return { repair: repair.id, remove: remove.id };
			},
			startPreflight() {
				Object.assign(globalThis, { preflightOutcome: 'pending' });
				void panel.preflight().then(
					() => Object.assign(globalThis, { preflightOutcome: 'departed' }),
					() => Object.assign(globalThis, { preflightOutcome: 'cancelled' }),
				);
			},
			blockPersistence() {
				const transaction = IDBDatabase.prototype.transaction;
				IDBDatabase.prototype.transaction = function (
					...args: Parameters<IDBDatabase['transaction']>
				) {
					if (args[1] === 'readwrite')
						throw new DOMException(
							'Synthetic quota failure',
							'QuotaExceededError',
						);
					return transaction.apply(this, args);
				};
				return () => {
					IDBDatabase.prototype.transaction = transaction;
				};
			},
		},
	});
} catch (error) {
	Object.assign(globalThis, {
		evidenceFailure: JSON.stringify(error, (_key, value) =>
			value instanceof Error
				? {
						name: value.name,
						message: value.message,
						stack: value.stack,
						cause: value.cause,
					}
				: value,
		),
	});
}
