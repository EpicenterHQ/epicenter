/**
 * What `createEpicenter` decides before it acquires anything.
 *
 * The handle is inert until `open`, so what is left to check here is the two
 * things construction refuses and the one thing it records. Everything about
 * opening, closing, and erasing a replica is `client-owned-data.test.ts`, which
 * drives a real IndexedDB.
 *
 * The binding tests that used to live here left with the binding: SQLite files
 * and secrets are `@epicenter/device`, and its own tests own them.
 */

import { expect, test } from 'bun:test';
import { createEpicenter } from './index.js';

const definition = { id: 'so.epicenter.notes' } as never;

test('the application id is explicit and independent from the definition id', () => {
	// The opening application is its own segment of the store address
	// (ADR-0324), so a reader application opening the notes definition is a
	// different replica rather than the same one under another name.
	expect(
		createEpicenter({ appId: 'so.epicenter.notes', definition }).appId,
	).toBe('so.epicenter.notes');
	expect(
		createEpicenter({ appId: 'so.epicenter.reader', definition }).appId,
	).toBe('so.epicenter.reader');
});

test('an application id this platform cannot file refuses at construction', () => {
	// It throws rather than answering a `Result`, because an id reaching this
	// is a constant in a build and a wrong one is a bug, not a condition.
	expect(() => createEpicenter({ appId: 'not an app id', definition })).toThrow(
		'is not valid',
	);
});
