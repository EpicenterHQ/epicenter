/**
 * The AttachRelay's one connect URL, shared by the host adapter and every
 * client so both address the relay the same way (ADR-0115).
 *
 * There is exactly one path (`/attach`): the relay is one surface, not a
 * directory of per-host or per-route endpoints. The endpoint addressing lives
 * in the query, and it is only ever the quadruple `principalId`, `hostId`,
 * `deviceId`, `attachId` plus the connecting `role`. `/attach` names the relay
 * itself, never a sub-surface of a host, so it is not a route in the sense
 * ADR-0115 forbids.
 *
 * The query carries `principalId` as part of the addressing quadruple, but the
 * authenticated mount stamps the principal from the resolved bearer and never
 * trusts the query value, so a client cannot address another partition by
 * putting one there. On self-host, a per-device grant resolves to the instance
 * principal; the addressing shape is independent of that credential policy.
 */

import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync/auth-subprotocol';

const stripTrailing = (s: string): string => s.replace(/\/+$/, '');

export const ATTACH_RELAY_ROUTE = {
	pattern: '/attach',
	/**
	 * The WebSocket subprotocols an attach client offers: the main one plus the
	 * bearer, carried as `bearer.<token>` because a browser upgrade cannot set
	 * `Authorization`. Every attach is authenticated, so both endpoints always
	 * offer these; the mount echoes only the main one on the 101, so the token
	 * never round-trips.
	 */
	subprotocols(bearer: string): string[] {
		return [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${bearer}`];
	},
	/**
	 * The host endpoint's connect URL: it registers under `(principalId, hostId)`.
	 * An optional `label` is directory metadata (ADR-0115 clause 3) the mount
	 * records for the host directory; it never reaches the coordinator, which
	 * stays label-blind. A host with no label lists under its `hostId`.
	 */
	hostUrl(
		baseURL: string,
		params: { principalId: string; hostId: string; label?: string },
	): string {
		const url = new URL(`${stripTrailing(baseURL)}/attach`);
		url.searchParams.set('role', 'host');
		url.searchParams.set('principalId', params.principalId);
		url.searchParams.set('hostId', params.hostId);
		if (params.label) url.searchParams.set('label', params.label);
		return url.toString();
	},
	/** A client endpoint's connect URL: it attaches under the full quadruple. */
	clientUrl(
		baseURL: string,
		params: {
			principalId: string;
			hostId: string;
			deviceId: string;
			attachId: string;
		},
	): string {
		const url = new URL(`${stripTrailing(baseURL)}/attach`);
		url.searchParams.set('role', 'client');
		url.searchParams.set('principalId', params.principalId);
		url.searchParams.set('hostId', params.hostId);
		url.searchParams.set('deviceId', params.deviceId);
		url.searchParams.set('attachId', params.attachId);
		return url.toString();
	},
} as const;
