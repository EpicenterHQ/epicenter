import { onMount } from 'svelte';
import { logAnalyticsEvent } from '$lib/operations/analytics';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

/** Log the one `app_started` analytics event per launch, once mounted. */
export function logAppStarted(app: WhisperingApp): void {
	onMount(() => {
		void logAnalyticsEvent(app, { type: 'app_started' });
	});
}
