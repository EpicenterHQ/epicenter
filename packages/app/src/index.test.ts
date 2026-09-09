/**
 * What `createEpicenter` decides before it acquires anything.
 *
 * Construction records the app identity without opening storage. The app
 * lifecycle tests in `app.test.ts` use fake IndexedDB to exercise acquisition.
 */

import { expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import { createEpicenter } from './index.js';
import { createBrowserAppBlobs } from './browser.js';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { Ok } from 'wellcrafted/result';

const sqlite: DeviceSqliteOwner = {
	acquire: async () => ({
		open: async () => ({
			query: async () => Ok({columns: [], rows: [], truncated: false}),
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			batch: async () => Ok({ changes: [] }),
		}),
		delete: async () => undefined,

		close: async () => undefined,
	}),
};
const blobs = createBrowserAppBlobs();

const definition = defineData({ id: 'so.epicenter.notes', tables: {}, kv: {} });

test('the application id is explicit and independent from the definition id', () => {
	// The opening application is its own segment of the store address
	// (ADR-0324), so a reader application opening the notes definition is a
	// different replica rather than the same one under another name.
	expect(
		createEpicenter({ appId: 'so.epicenter.notes', definition, sqlite, blobs })
			.appId,
	).toBe('so.epicenter.notes');
	expect(
		createEpicenter({ appId: 'so.epicenter.reader', definition, sqlite, blobs })
			.appId,
	).toBe('so.epicenter.reader');
});

test('an application id this platform cannot file refuses at construction', () => {
	// It throws rather than answering a `Result`, because an id reaching this
	// is a constant in a build and a wrong one is a bug, not a condition.
	expect(() =>
		createEpicenter({ appId: 'not an app id', definition, sqlite, blobs }),
	).toThrow('is not valid');
});
