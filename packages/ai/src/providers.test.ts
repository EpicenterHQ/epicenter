/**
 * Provider label resolution contract.
 *
 * Pins the one behavior the type system cannot: an id this deploy does not
 * recognize falls back to the raw string rather than throwing. The activity
 * feed reads arbitrary historical provider ids off persisted billing events, so
 * one unrecognized id must degrade to a single literal cell instead of failing
 * the whole read. "Every live provider has a label" is left to the
 * `AI_PROVIDERS satisfies Record<AiProvider>` compile guard, not duplicated here.
 */

import { expect, test } from 'bun:test';
import { providerLabel } from './providers.js';

test('resolves a known provider id to its vendor label', () => {
	// gemini -> Google is the non-obvious mapping worth pinning: the vendor
	// name is not the provider id.
	expect(providerLabel('gemini')).toBe('Google');
});

test('falls back to the raw id for an unrecognized provider', () => {
	// A provider retired from the live catalog, or one newer than this deploy,
	// still renders: its id is returned verbatim instead of throwing.
	expect(providerLabel('anthropic')).toBe('anthropic');
	expect(providerLabel('')).toBe('');
});
