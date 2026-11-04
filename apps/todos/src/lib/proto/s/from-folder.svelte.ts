// PROTOTYPE option (s), standing for `@epicenter/folder/svelte`'s `fromFolder`:
// a tracked `state` getter over `folder.state()`, subscribed while read.
import { createSubscriber } from 'svelte/reactivity';
import type { Folder } from './folder.js';

export function fromFolder<TClient>(folder: Folder<TClient>) {
	const track = createSubscriber((update) => folder.subscribe(update));
	return {
		get state() {
			track();
			return folder.state();
		},
	};
}
