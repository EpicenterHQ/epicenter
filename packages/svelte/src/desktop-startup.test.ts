/**
 * Desktop startup retry tests.
 *
 * Key behaviors:
 * - A desktop app without settings opens Data again on each Retry.
 */
import './svelte-dom.test-support.js';
import { expect, mock, test } from 'bun:test';

let opens = 0;
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: async (command: string, args: { root: string }) => {
		expect(command).toBe('plugin:epicenter-folder|open_root');
		expect(args.root).toBe('Data');
		opens++;
		throw { name: 'Unavailable', folder: '/notes', message: 'offline' };
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async () => () => {},
}));

const { flushSync, mount, unmount } = await import('svelte');
const { default: DesktopStartupHost } = await import(
	'./fixtures/DesktopStartupHost.svelte'
);

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('a second Retry opens Data a third time without settings', async () => {
	opens = 0;
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(DesktopStartupHost, { target });
	try {
		await until(() => opens === 1 && target.querySelector('button') !== null);
		for (const expected of [2, 3]) {
			(target.querySelector('button') as HTMLButtonElement).click();
			await until(
				() => opens === expected && target.querySelector('button') !== null,
			);
		}
	} finally {
		await unmount(view);
		target.remove();
	}
});
