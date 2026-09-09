import './style.css';
import { defineApplication } from '@epicenter/app';
import { syncEngineOf } from '@epicenter/data/direct';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { mailDefinition } from '../../src/lib/data.js';
import { mount } from 'svelte';
import Panel from './Panel.svelte';
import { app, account } from './application.js';
import { mail } from '../../src/lib/mail.js';
import { openLocalMailStorage } from '../../../src/storage.js';
import { expectOk } from 'wellcrafted/testing';

try {
	const ready = await app.ready;
	if (ready.error) throw ready.error;
	const storage = await openLocalMailStorage(app);
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
				const peer = defineApplication({
					appId: 'so.epicenter.local-mail-evidence-peer',
					definition: mailDefinition,
				}).openAccount({
					...account,
					fetch: async () =>
						Response.json({ generations: [], generation: 1, position: 0 }),
				});
				expectOk(await peer.ready);
				expectOk(syncEngineOf(peer).applyRemote(app.encodeStateSince()));
				const row = peer.tables.savedQueries.rows[0]!;
				if (remove) peer.tables.savedQueries.delete(row.id);
				else
					expectOk(
						peer.tables.savedQueries.update(row.id, {
							sql: 'SELECT id FROM labels',
						}),
					);
				expectOk(syncEngineOf(app).applyRemote(peer.encodeStateSince()));
				await app.persistence.flush();
				await peer.close();
			},
			async malformed() {
				const peer = defineApplication({
					appId: 'so.epicenter.local-mail-evidence-malformed',
					definition: defineData({
						id: mailDefinition.id,
						kv: {},
						tables: {
							savedQueries: defineTable({
								name: field.string(),
								sql: field.boolean(),
							}),
						},
					}),
				}).openAccount({
					...account,
					fetch: async () =>
						Response.json({ generations: [], generation: 1, position: 0 }),
				});
				expectOk(await peer.ready);
				const repair = peer.tables.savedQueries.create({
					name: 'Repair fixture',
					sql: false,
				});
				const remove = peer.tables.savedQueries.create({
					name: 'Delete fixture',
					sql: true,
				});
				expectOk(syncEngineOf(app).applyRemote(peer.encodeStateSince()));
				await app.persistence.flush();
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
