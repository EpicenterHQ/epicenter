/**
 * Per-device attach grants (ADR-0115): the revocable allowlist that replaces the
 * single shared operator token on the attach surface.
 *
 * ## Why this exists
 *
 * A single shared operator bearer (`INSTANCE_TOKEN`) cannot let one device in and
 * another out: every device that holds the token attaches, and there is no way to
 * cut just one off. Per-device grants split that one credential into a revocable
 * list. A device pairs once (the operator mints it a grant, handed over out of
 * band as a QR or a paste), presents that grant on connect, and revoking the
 * grant kills the device's next attach without touching any other device or the
 * sync plane.
 *
 * ## Where it sits, and what it does not touch
 *
 * This is the "account and device layer" ADR-0115 clause 3 puts pairing and
 * device grants in: it lives beside the attach mount (`attach-relay/mount.ts`),
 * NOT inside the relay coordinator (`attach-relay/core.ts`). The coordinator stays
 * grant-blind and frame-blind: it still forwards opaque bytes addressed by
 * `principalId`, `hostId`, `deviceId`, `attachId`, and it never learns a grant
 * exists. The grant is checked once, at the mount's auth boundary, before the
 * socket ever reaches the coordinator.
 *
 * ## The seam it fills
 *
 * The store's {@link DeviceGrantStore.resolveBearerPrincipal} is a plain
 * {@link ResolveBearerPrincipal}: exactly the seam `createEnvTokenResolver`
 * fills, so the attach mount closes over it with no change to
 * `mountAttachRelayApp`. It resolves any LIVE grant to the one instance principal
 * (`INSTANCE_PRINCIPAL_ID`), the same principal the operator
 * token resolves to, so grants never re-partition: they are a finer credential for
 * the same single partition (ADR-0075), never a second principal model.
 *
 * ## Grant shape
 *
 * A grant's secret is a strong random URL-safe token (the same generator the
 * operator token uses). The store keeps only the token's SHA-256 digest, never the
 * raw secret: `mint` returns the secret once (the pairing payload), and thereafter
 * only its hash is at rest. Resolution hashes the presented bearer and looks the
 * digest up, so a timing attacker would need a preimage of the digest to forge a
 * grant, the same argument `createEnvTokenResolver`'s constant-time compare rests
 * on. Revocation deletes the digest, so the next connect misses the lookup and
 * fails closed.
 *
 * ## Deliberately not built here (smallest model, ADR-0115 clause 3)
 *
 * - The grant is not bound to the connect's query `deviceId`: the `deviceId` is
 *   recorded at mint time so the operator can see and revoke "my old phone," but
 *   the relay's `deviceId`/`attachId` stay opaque addressing labels, never trusted
 *   identity. Binding a grant to one `deviceId` at connect is a refinement
 *   deferred until a directory needs trusted device identity.
 * - Grants are not scoped by role: any live grant can register as a host or attach
 *   as a client. On a single-principal instance every grant is the operator's own
 *   paired device, so role scoping would guard only within-owner behavior; it is
 *   deferred until a real threat earns it.
 * - Revocation kills future connects, not live sockets: closing an in-flight
 *   attach on revoke would make the store hold socket handles or reach into the
 *   coordinator, and the target is "dead on the next connect." Live-socket
 *   eviction is a later refinement.
 * - The store is in-memory: grants do not survive a process restart, so a restart
 *   re-pairs devices. Persisting them in the deployment's data directory is
 *   deferred until a real need earns it.
 */

import { generateInstanceToken, Principal } from '@epicenter/auth';
import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import type { ResolveBearerPrincipal } from '../types.js';

/**
 * A minted device grant's public record: everything the operator's list view
 * shows. It carries NO secret; the secret is returned once from {@link
 * DeviceGrantStore.mint} and never stored in the clear.
 */
export type DeviceGrant = {
	/** Stable id for this grant; the operator revokes by this. */
	id: string;
	/** The device this grant was minted for, the operator's label to revoke by. */
	deviceId: string;
	/** An optional human label for the operator's list ("Braden's phone"). */
	label: string | undefined;
	/** When the grant was minted (epoch ms). */
	createdAt: number;
};

/**
 * The revocable per-device attach allowlist. `resolveBearerPrincipal` is the
 * attach mount's auth seam; `mint`/`list`/`revoke` are the operator's admin
 * surface (`mountAttachGrantsApp`), gated by the operator token.
 */
export type DeviceGrantStore = {
	/**
	 * Resolve a presented attach bearer to the instance principal iff it is a
	 * live grant. A revoked or never-minted bearer resolves to `InvalidToken`,
	 * the same arm the operator-token resolver returns, so the attach mount
	 * rejects it unchanged (a fail-closed handshake).
	 */
	resolveBearerPrincipal: ResolveBearerPrincipal;
	/**
	 * Mint a grant for a device and return it WITH its secret, exactly once. The
	 * secret is the pairing payload (a QR or a paste); the store keeps only its
	 * hash thereafter.
	 */
	mint(params: {
		deviceId: string;
		label?: string;
	}): Promise<DeviceGrant & { token: string }>;
	/** Every live grant's public record (no secrets), for the operator's list. */
	list(): DeviceGrant[];
	/** Revoke a grant by id; returns whether a grant was found and removed. */
	revoke(id: string): boolean;
};

/** The one principal every grant resolves to: this is a single-partition instance. */
const instancePrincipal = Principal.assert({ id: INSTANCE_PRINCIPAL_ID });

/** SHA-256 of a token as lowercase hex, the digest the store keys grants by. */
async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}

/**
 * Build one in-memory device-grant store. A self-hosted instance holds one of
 * these for its attach surface: the attach mount closes over its
 * `resolveBearerPrincipal`, and the operator token's admin surface drives its
 * `mint`/`list`/`revoke`.
 */
export function createDeviceGrantStore(): DeviceGrantStore {
	/** Grant records by id, the unit the operator lists and revokes. */
	const byId = new Map<string, { grant: DeviceGrant; tokenHash: string }>();
	/** Token digest to grant id, the lookup the resolver hits on every connect. */
	const idByTokenHash = new Map<string, string>();

	return {
		resolveBearerPrincipal: async (_c, presented) => {
			const id = idByTokenHash.get(await sha256Hex(presented));
			return id !== undefined && byId.has(id)
				? Ok(instancePrincipal)
				: OAuthError.InvalidToken();
		},

		async mint({ deviceId, label }) {
			const token = generateInstanceToken();
			const tokenHash = await sha256Hex(token);
			const grant: DeviceGrant = {
				id: crypto.randomUUID(),
				deviceId,
				label,
				createdAt: Date.now(),
			};
			byId.set(grant.id, { grant, tokenHash });
			idByTokenHash.set(tokenHash, grant.id);
			return { ...grant, token };
		},

		list() {
			return Array.from(byId.values(), (entry) => entry.grant);
		},

		revoke(id) {
			const entry = byId.get(id);
			if (!entry) return false;
			byId.delete(id);
			idByTokenHash.delete(entry.tokenHash);
			return true;
		},
	};
}
