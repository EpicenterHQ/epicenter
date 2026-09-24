import { AnalyticsError, type AnalyticsService } from './types.js';

export type { AnalyticsError, AnalyticsService, Event } from './types.js';

/** No analytics client is configured for this build. */
export const AnalyticsServiceLive: AnalyticsService = {
	async logEvent() {
		return AnalyticsError.LogEventFailed({
			cause: new Error('Analytics is not configured in this build.'),
		});
	},
};
