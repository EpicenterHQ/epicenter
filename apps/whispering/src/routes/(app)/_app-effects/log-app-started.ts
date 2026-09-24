import { onMount } from 'svelte';
import { logAnalyticsEvent } from '$lib/operations/analytics';
import type { WhisperingApp } from '$lib/whispering/app';

/** Log the one `app_started` analytics event per launch, once mounted. */
export function logAppStarted(app: WhisperingApp): void {
	onMount(() => {
		void logAnalyticsEvent({ type: 'app_started' });
	});
}
