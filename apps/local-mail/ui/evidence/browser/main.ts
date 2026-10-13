import { openPersonal } from '@epicenter/app/open';
import './style.css';
import { defineStore, defineTable, field } from '@epicenter/app';
import { syncEngineOf } from '@epicenter/app/data';
import type { Account } from '@epicenter/auth';
import { mount, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import { openLocalMailStorage } from '../../../src/storage.js';
import { mailDefinition } from '../../src/lib/data.js';
import { attachMail, mail } from '../../src/lib/mail.js';
import { currentStoreResponse } from '../current-store.js';
import { account, opening } from './application.js';
import Panel from './Panel.svelte';

try {
	const app = await opening;
	const closeMail = attachMail(app);
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
				await unmount(panel);
				await closeMail();
				await app.close();
			},
			async remoteEdit(remove = false) {
				const peer = await openPersonal(
					defineStore({
						...mailDefinition,
						id: 'so.epicenter.local-mail-evidence',
					}),
					{
						account: {
							...account,
							principalId: 'synthetic-peer' as Account['principalId'],
							fetch: (input, init) =>
								currentStoreResponse(new Request(input, init)),
						},
					},
				);
				expectOk(
					syncEngineOf(peer).applyRemote(app.personal.encodeStateSince()),
				);
				const row = peer.tables.savedQueries.rows[0]!;
				if (remove) peer.tables.savedQueries.delete(row.id);
				else
					expectOk(
						peer.tables.savedQueries.update(row.id, {
							sql: 'SELECT id FROM labels',
						}),
					);
				expectOk(
					syncEngineOf(app.personal).applyRemote(peer.encodeStateSince()),
				);
				await app.personal.persistence.flush();
				await peer.close();
			},
			async malformed() {
				const peer = await openPersonal(
					defineStore({
						kv: {},
						tables: {
							savedQueries: defineTable({
								fields: {
									name: field.string(),
									sql: field.boolean(),
								},
							}),
						},
						id: 'so.epicenter.local-mail-evidence',
					}),
					{
						account: {
							...account,
							principalId: 'synthetic-malformed' as Account['principalId'],
							fetch: (input, init) =>
								currentStoreResponse(new Request(input, init)),
						},
					},
				);
				const repair = peer.tables.savedQueries.create({
					name: 'Repair fixture',
					sql: false,
				});
				const remove = peer.tables.savedQueries.create({
					name: 'Delete fixture',
					sql: true,
				});
				expectOk(
					syncEngineOf(app.personal).applyRemote(peer.encodeStateSince()),
				);
				await app.personal.persistence.flush();
				await peer.close();
				return { repair: repair.id, remove: remove.id };
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
			/**
			 * Hand the page each SQL run's answer only after `release`. The run
			 * still reaches the storage worker at once, so a test can let the
			 * worker answer, change the page, and only then deliver the answer.
			 */
			holdQueries() {
				const { query } = mail;
				const gate = Promise.withResolvers<void>();
				const held: Promise<unknown>[] = [];
				mail.query = (...args) => {
					const answer = query(...args);
					held.push(answer);
					return answer.finally(() => gate.promise);
				};
				return {
					/** Settles once the worker has answered every held run. */
					async answered() {
						await Promise.allSettled(held);
					},
					/** Deliver the held answers; settles once the page has them. */
					async release() {
						mail.query = query;
						gate.resolve();
						await Promise.allSettled(held);
						// A macrotask: the page has acted on every answer by then.
						await new Promise((resolve) => setTimeout(resolve, 0));
					},
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
