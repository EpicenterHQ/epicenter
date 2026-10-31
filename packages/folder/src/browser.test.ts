/** The device client over this origin's private file system, in Bun. */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { closeDevice, openDevice } from './browser.js';

test('a disposed device stops its Worker, and every later call is Unavailable', async () => {
	const device = unwrap(
		await openDevice(
			defineContract({
				name: 'recorder',
				collections: { audio: { path: 'recordings/{id}.{ext}' } },
			}),
		),
	);
	// Starts the Worker; Bun has no private file system, so it answers either way.
	await device.audio.list();
	closeDevice(device);
	const after = await device.audio.list();
	expect(after.error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'WorkerFailed' },
	});
});
