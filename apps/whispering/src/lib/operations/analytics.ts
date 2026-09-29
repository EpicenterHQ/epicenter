import { services } from '$lib/services';
import type { Event } from '$lib/services/analytics/types';
import { local } from '../whispering/local.js';
import { DEVICE_DEFAULTS } from './settings.js';

/**
 * Log an anonymous analytics event if analytics is enabled in settings.
 */
export async function logAnalyticsEvent(event: Event): Promise<void> {
	if (!(local.kv.get('analyticsEnabled') ?? DEVICE_DEFAULTS.analyticsEnabled))
		return;
	await services.analytics.logEvent(event);
}
