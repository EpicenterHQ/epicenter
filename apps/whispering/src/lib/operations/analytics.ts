import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import type { WhisperingApp } from '$lib/whispering/app';
import { DEVICE_DEFAULTS } from './settings.js';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export async function logAnalyticsEvent(
	app: WhisperingApp,
	event: Event,
): Promise<void> {
	if (
		!(app.local.kv.get('analyticsEnabled') ?? DEVICE_DEFAULTS.analyticsEnabled)
	)
		return;
	await services.analytics.logEvent(event);
}
