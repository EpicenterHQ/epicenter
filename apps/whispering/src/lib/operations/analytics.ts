import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import type { WhisperingApp } from '$lib/whispering/app';
import { getSetting } from './settings.js';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export async function logAnalyticsEvent(
	app: WhisperingApp,
	event: Event,
): Promise<void> {
	if (!getSetting(app.device.kv, 'analyticsEnabled')) return;
	await services.analytics.logEvent(event);
}
