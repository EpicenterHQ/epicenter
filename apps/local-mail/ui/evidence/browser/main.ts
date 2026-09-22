import { openPersonal } from '@epicenter/app/open';
import './style.css';
import { defineApp, defineTable, field } from '@epicenter/app';
import { syncEngineOf } from '@epicenter/app/data';
import type { Account } from '@epicenter/auth';
import { mount, unmount } from 'svelte';
import { expectOk } from 'wellcrafted/testing';
import { openLocalMailStorage } from '../../../src/storage.js';
import { mailDefinition } from '../../src/lib/data.js';
import { attachMail, mail } from '../../src/lib/mail.js';
import { currentLibraryResponse } from '../current-library.js';
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
					defineApp({
						...mailDefinition,
						id: 'so.epicenter.local-mail-evidence',
					}),
					{
						account: {
							...account,
							principalId: 'synthetic-peer' as Account['principalId'],
							fetch: (input, init) =>
								currentLibraryResponse(new Request(input, init)),
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
					defineApp({
						kv: {},
						tables: {
							savedQueries: defineTable({
								name: field.string(),
								sql: field.boolean(),
							}),
						},
						id: 'so.epicenter.local-mail-evidence',
					}),
					{
						account: {
							...account,
							principalId: 'synthetic-malformed' as Account['principalId'],
							fetch: (input, init) =>
								currentLibraryResponse(new Request(input, init)),
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
