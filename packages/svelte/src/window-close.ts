/**
 * Hold a desktop window's close until the page's writes land.
 * The Folder plugin sends the first close over a private channel. Closing
 * again while the page waits asks natively whether to close anyway.
 */
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/window-close');
let held = false;

export async function holdWindowClose(
	drain: () => Promise<void> = async () => {},
): Promise<() => void> {
	if (!isTauri() || held) return () => {};
	held = true;
	let holding = true;
	let phase: 'open' | 'waiting' | 'gone' = 'open';
	let wasInert = false;
	const registered = Promise.withResolvers<number>();
	const channel = new Channel<null>();
	channel.onmessage = async () => {
		if (!holding || phase !== 'open') return;
		phase = 'waiting';
		wasInert = document.documentElement.inert;
		document.documentElement.inert = true;
		try {
			await drain();
		} catch (cause) {
			log.error(new Error('The window could not wait for its writes', { cause }));
		}
		if (!holding || phase !== 'waiting') return;
		phase = 'gone';
		try {
			const token = await registered.promise;
			const destroyed = await invoke<boolean>(
				'plugin:epicenter-folder|destroy_bound_window',
				{ token },
			);
			if (destroyed) return;
		} catch (cause) {
			log.error(new Error('The window could not close', { cause }));
		}
		if (!holding) return;
		phase = 'open';
		document.documentElement.inert = wasInert;
	};

	try {
		const token = await invoke<number>('plugin:epicenter-folder|subscribe_close', {
			onClose: channel,
		});
		registered.resolve(token);
		return () => {
			if (!holding) return;
			holding = false;
			held = false;
			channel.onmessage = () => {};
			if (phase === 'waiting') document.documentElement.inert = wasInert;
			void invoke('plugin:epicenter-folder|unsubscribe_close', { token });
		};
	} catch (cause) {
		holding = false;
		held = false;
		channel.onmessage = () => {};
		throw cause;
	}
}
