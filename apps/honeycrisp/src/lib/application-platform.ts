import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import type { HoneycrispDependencies } from './application.js';
import { openHoneycrispBrowserEpicenter } from './data/browser.js';

const log = createLogger('honeycrisp/application');

/** Inert browser dependencies. Storage does not open until the root calls open. */
export const honeycrispPlatform: HoneycrispDependencies = {
	openEpicenter: () =>
		openHoneycrispBrowserEpicenter({
			auth,
			reportBackgroundError: (cause) =>
				log.warn(new Error('Honeycrisp background sync failed', { cause })),
		}),
	reportBackgroundError: (cause) =>
		log.warn(new Error('Honeycrisp background refresh failed', { cause })),
};
