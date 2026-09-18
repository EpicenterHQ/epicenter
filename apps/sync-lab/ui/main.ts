import { field, plainText } from '@epicenter/data/definition';

/**
 * THROWAWAY. One page, two devices, one row crossing between them.
 *
 * The store is held in an in-memory SQLite, deliberately. This surface is not
 * claiming durability across a reload; it is claiming that a row written on one
 * device appears on another through a deployed Durable Object, which is the one
 * thing no test in this repository can establish.
 */

import { defineData, defineTable } from '@epicenter/data/definition';
import { openAccountStore } from '@epicenter/data/direct';
import { createSyncConnection } from '@epicenter/data/sync';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const labDatabase = defineData({
	id: 'so.epicenter.synclab',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			device: field.string(),
			at: field.string(),
			body: field.string(),
			content: plainText(),
		}),
	},
});

const device =
	localStorage.getItem('sync-lab-device') ??
	(() => {
		const minted = `${navigator.platform || 'device'}-${Math.random().toString(36).slice(2, 6)}`;
		localStorage.setItem('sync-lab-device', minted);
		return minted;
	})();

const sqlite3 = await sqlite3InitModule();
const db = await openAccountStore({
	definition: labDatabase,
	sqlite: createBrowserSqliteAdapter(new sqlite3.oo1.DB(':memory:')),
});
const store = db;

/**
 * The whole of what this host writes: how to make a socket.
 *
 * Reconnecting on close, reconnecting when the client reports `needsResync`,
 * putting the cursor in the URL and watching for a submission nobody answers
 * are all the driver's, because every one of them is correctness rather than
 * transport, and the version of this file that owned them by hand was missing
 * two of the four.
 */
const connection = createSyncConnection({
	onRetired() {
		throw new Error('This sync laboratory does not restore generations');
	},
	store,
	dial: ({ cursor, opened, received, closed }) => {
		const url = new URL('/sync', location.href);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('app', 'lab');
		url.searchParams.set('cursor', String(cursor));
		const socket = new WebSocket(url);
		socket.binaryType = 'arraybuffer';

		socket.addEventListener('open', () => {
			opened({ send: (bytes) => socket.send(bytes) });
			render();
		});
		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') return;
			received(new Uint8Array(event.data as ArrayBuffer));
			render();
		});
		socket.addEventListener('close', () => {
			closed();
			render();
		});
		socket.addEventListener('error', () => socket.close());
		return () => socket.close();
	},
	idleMs: 1_000,
});

const rows = document.querySelector('#rows') as HTMLElement;
const status = document.querySelector('#status') as HTMLElement;
const title = document.querySelector('#title') as HTMLInputElement;
const record = document.querySelector('#record') as HTMLButtonElement;
const paste = document.querySelector('#paste') as HTMLButtonElement;

/** The one number worth watching: how much of this document is dead weight. */
function pressureLine(): string {
	const pressure = store.pressure();
	return `${pressure.items} items / ${pressure.liveRows} rows = ${pressure.itemsPerLiveRow.toFixed(1)}`;
}

function render(): void {
	const listed = db.tables.notes;
	rows.replaceChildren(
		...listed.rows
			.sort((left, right) => left.at.localeCompare(right.at))
			.map((row) => {
				const item = document.createElement('li');
				item.textContent = `${row.title}  ·  ${row.device}`;
				item.className = row.device === device ? 'mine' : 'theirs';
				return item;
			}),
	);
	const state = connection.status();
	status.textContent = [
		`device ${device}`,
		`cursor ${state.cursor}`,
		state.connected ? 'connected' : `dialling (failures ${state.failures})`,
		state.inFlight ? `in flight (${state.owed} B)` : 'idle',
		state.lastError === undefined
			? 'no errors'
			: `ERROR ${state.lastError.message}`,
		state.unresolvedDependencies ? 'UNRESOLVED DEPENDENCIES' : '',
		state.lastReconnect === undefined
			? ''
			: `last reconnect: ${state.lastReconnect}`,
		pressureLine(),
	]
		.filter(Boolean)
		.join('  ·  ');
}

function write(fields: { title: string }): void {
	db.tables.notes.create({
		title: fields.title,
		device,
		at: new Date().toISOString(),
		body: '',
	});
	// Nothing nudges. The store announces the work it authored and the driver
	// starts the idle timer, which is what turns a burst of transactions into
	// one entry and is the whole reason the log is affordable to never compact.
	render();
}

record.addEventListener('click', () => {
	write({ title: title.value.trim() || 'untitled' });
	title.value = '';
});

title.addEventListener('keydown', (event) => {
	if (event.key === 'Enter') record.click();
});

paste.addEventListener('click', () => {
	// One transaction well past the 2,097,152-byte storage cap, so the chunking
	// path is exercised by hand on a real device rather than only in a test.
	db.tables.notes.create({
		title: 'a 3 MB paste',
		device,
		at: new Date().toISOString(),
		body: 'x'.repeat(3_000_000),
	});
	render();
});

render();
connection.start();
