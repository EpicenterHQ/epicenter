import { expect, test } from 'bun:test';
import { epicenterHost } from './epicenter-host.js';
import { resources } from './platform/epicenter-host.js';
import { createDesktopRecording } from './recording/desktop.js';

test('the host default selects native recording and the explicit host runtime together', () => {
	expect(resources).toBe(epicenterHost);
	expect(resources.recording).toBe(createDesktopRecording);
	const bytes = resources.blobs({ appId: 'com.test.blobs', account: null });
	expect(bytes.remote).toBeNull();
	expect(typeof bytes.local.list).toBe('function');
});
