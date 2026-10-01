import { invoke } from '@tauri-apps/api/core';
import { tryAsync } from 'wellcrafted/result';
import type { AnalyticsService } from './types';
import { AnalyticsError } from './types';

export type { AnalyticsError, AnalyticsService, Event } from './types';

export const AnalyticsServiceLive: AnalyticsService = {
	logEvent: async (event) =>
		tryAsync({
			try: async () => {
				const { type, ...properties } = event;
				await invoke<void>('plugin:aptabase|track_event', {
					name: type,
					props: properties,
				});
			},
			catch: (error) => AnalyticsError.LogEventFailed({ cause: error }),
		}),
};
