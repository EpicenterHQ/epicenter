import type { ObservationFrame } from '@epicenter/lens';
import type {
	BrowserOperation,
	SerializedTableDefinition,
	SerializedValueDefinition,
} from './browser/protocol.js';
import type { RowAddress } from './protocol/index.js';
import type { ThrownErrorDescription } from './thrown-error.js';

export const DESKTOP_EPICENTER_ROUTE = '/api/data';

/**
 * The host-owned observation carrier for desktop surfaces.
 *
 * One socket per surface, on a bounded route below `/api/data`, carrying
 * nothing but committed addresses. It is deliberately not general HTTP
 * observation: ADR-0185 keeps an installed app's ordinary HTTP unobserved, and
 * this socket observes Epicenter's own replica rather than an app's traffic.
 */
export const DESKTOP_EPICENTER_OBSERVE_ROUTE = '/api/data/observe';

/**
 * One committed replica notification on its way to every attached surface.
 *
 * The same frame every observation carrier reads, named here for the host that
 * writes it. `@epicenter/lens` declares it once because the client-side carrier
 * parses it; a second structural copy on the producing side would be exactly the
 * drift this route cannot afford.
 */
export type DesktopInvalidationFrame = ObservationFrame;

/** The `ws:`/`wss:` URL of the observation carrier for one Epicenter origin. */
export function desktopEpicenterObserveUrl(baseUrl: string): string {
	const url = new URL(DESKTOP_EPICENTER_OBSERVE_ROUTE, baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

/**
 * Desktop and browser adapters share the same definition and operation wire
 * vocabulary. Their carrier envelopes differ because the browser uses a
 * MessagePort while the desktop uses authenticated same-origin HTTP.
 */
export type DesktopOperation =
	| Exclude<
			BrowserOperation,
			| { kind: 'attach-sync' }
			| { kind: 'sync-credentials' }
			| { kind: 'document-update' }
			| { kind: 'table-update' }
	  >
	/**
	 * An update names what to write and what to remove, rather than carrying one
	 * patch object with `undefined` holes in it.
	 *
	 * The browser adapter can keep the patch, because a MessagePort structured
	 * clone preserves `undefined`. JSON does not: `JSON.stringify` drops a key
	 * whose value is `undefined` entirely, so a patch that meant "remove this
	 * optional field" arrived at the host as a patch that meant nothing, and the
	 * field silently survived. Naming the two halves is the only way a JSON
	 * carrier can say the difference, and it is also the shape the replica intent
	 * already has.
	 */
	| {
			kind: 'table-update';
			definition: SerializedTableDefinition;
			address: RowAddress;
			set: Record<string, unknown>;
			unset: string[];
	  }
	| { kind: 'document-update'; documentId: number; update: string }
	| { kind: 'document-refresh'; documentId: number };

export type DesktopRequest = {
	surfaceId: string;
	operation: DesktopOperation;
};

export type DesktopResponse =
	| { data: unknown; error: null }
	| { data: null; error: ThrownErrorDescription };

export function desktopEpicenterUrl(baseUrl: string): string {
	return new URL(DESKTOP_EPICENTER_ROUTE, baseUrl).toString();
}

export {
	describeThrownError,
	type ThrownErrorDescription,
} from './thrown-error.js';
export type { SerializedTableDefinition, SerializedValueDefinition };
