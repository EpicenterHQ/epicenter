import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingSettingValues } from '$lib/data';
import type { WhisperingSettings } from '$lib/whispering/app';

export type BooleanSettingKey = {
	[K in keyof WhisperingSettingValues]: WhisperingSettingValues[K] extends boolean
		? K
		: never;
}[keyof WhisperingSettingValues];

/**
 * Reactive view over the app's hydrated settings: same interface,
 * but reads performed inside a template, `$derived`, or `$effect` re-run
 * when a bound Data value commits. The subscription is ref-counted to effect
 * usage via `createSubscriber`, so an unmounted tree holds no listener.
 */
export function createSettingsView(
	settings: WhisperingSettings,
): WhisperingSettings {
	const invalidate = createSubscriber((update) => settings.subscribe(update));
	return {
		get(key) {
			invalidate();
			return settings.get(key);
		},
		set: settings.set,
		getDefault: settings.getDefault,
		reset: settings.reset,
		subscribe: settings.subscribe,
	};
}
