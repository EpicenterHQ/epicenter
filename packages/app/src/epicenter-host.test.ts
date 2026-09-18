/** The host build selects native recording and host-backed blob access. */
import { expect, test } from 'bun:test';
import { resources } from './platform/epicenter-host.js';
import { createDesktopRecording } from './recording/desktop.js';

test('the host resources select native recording and host blob access', () => {
	expect(resources.recording).toBe(createDesktopRecording);
	const bytes = resources.blobs({ appId: 'com.test.blobs' });
	expect(bytes.remote).toBeNull();
	expect(typeof bytes.local.list).toBe('function');
});
