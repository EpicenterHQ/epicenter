/**
 * Desktop folder recovery and location tests.
 *
 * Key behaviors:
 * - Each opening failure has one plain message and two actions.
 * - Reveal names the failed root, and onboarding shows the opened path.
 */
import './svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';

const revealed: string[] = [];
mock.module('@epicenter/folder/tauri', () => ({
	revealRoot: async (root: string) => {
		revealed.push(root);
		return { data: null, error: null };
	},
}));

const { flushSync, mount, unmount } = await import('svelte');
const { default: Recovery } = await import('./recovery.svelte');
const { default: FolderOnboarding } = await import('./folder-onboarding.svelte');

const errors = [
	{
		name: 'Disconnected',
		message: 'old message',
		folder: '/home/me/Epicenter/capture',
		target: '/Volumes/offline/capture',
		expected: "This folder is a link to a place that isn't available, such as a disconnected drive.",
	},
	{ name: 'Refused', message: 'This location is your home folder.', folder: '/home/me', reason: 'This location is your home folder.', expected: 'This location is your home folder.' },
	{ name: 'Unreadable', message: 'The folder could not be opened.', folder: '/notes', cause: 'permission denied', expected: 'The folder could not be opened.' },
	{ name: 'StorageUnavailable', message: 'Storage is offline.', cause: 'offline', expected: 'Storage is offline.' },
] as const;

for (const error of errors) {
	test(`Recovery shows ${error.name} with Retry and file manager actions`, async () => {
		let retries = 0;
		const target = document.createElement('div');
		document.body.append(target);
		const view = mount(Recovery, {
			target,
			props: { app: 'Capture', error, retry: () => retries++ },
		});
		try {
			flushSync();
			expect(target.textContent).toContain(error.expected);
			if (error.name === 'Disconnected') expect(target.textContent).toContain(error.folder);
			const buttons = [...target.querySelectorAll('button')];
			expect(buttons).toHaveLength(2);
			expect(buttons[0]?.textContent).toBe('Retry');
			expect(buttons[1]?.textContent).toMatch(/^Show in Finder$|^Show folder$/);
			buttons[0]?.click();
			expect(retries).toBe(1);
			revealed.length = 0;
			buttons[1]?.click();
			await Bun.sleep(0);
			expect(revealed).toEqual(['Data']);
		} finally {
			await unmount(view);
			target.remove();
		}
	});
}

test('Recovery reveals AppData when settings failed', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(Recovery, {
		target,
		props: { app: 'Capture', error: errors[3], appDataError: true, retry: () => {} },
	});
	try {
		flushSync();
		revealed.length = 0;
		target.querySelectorAll('button')[1]?.click();
		await Bun.sleep(0);
		expect(revealed).toEqual(['AppData']);
	} finally {
		await unmount(view);
		target.remove();
	}
});

test('onboarding shows the path returned for the open folder', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(FolderOnboarding, {
		target,
		props: { noun: 'captures', path: '/home/me/Epicenter/capture' },
	});
	try {
		flushSync();
		expect(target.textContent).toContain('Your captures are files in /home/me/Epicenter/capture.');
		revealed.length = 0;
		target.querySelector('button')?.click();
		await Bun.sleep(0);
		expect(revealed).toEqual(['Data']);
	} finally {
		await unmount(view);
		target.remove();
	}
});
