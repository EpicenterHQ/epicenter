/**
 * Address byte ceilings and raw encoded-size helpers.
 *
 * What is left here after the combined exchange was deleted: the ceilings that
 * bound a durable address coordinate, and two byte-measuring helpers. Everything
 * that used to live beside them (fact and intent admission, the JSON walker, the
 * batch and page limits) belonged to that protocol and went with it. The scalar
 * V1 kernel carries its own admission, parameterized by `ValidatedLimits` rather
 * than frozen here, so nothing in this module decides what the wire accepts.
 *
 * The address ceilings stay because an address is not part of any one protocol:
 * the Lens grammar, the replica, the authority, and the inspection host all
 * bound the same coordinates, and `SCALAR_V1_LIMITS` carries these same numbers
 * forward for the wire.
 */
import type { AddressByteCeilings } from './addresses.js';

const textEncoder = new TextEncoder();

/** The address-coordinate ceilings Epicenter admits. */
export const DATA_ADDRESS_CEILINGS: AddressByteCeilings = {
	/** Byte ceiling for the durable reverse-domain namespace coordinate. */
	namespaceBytes: 128,
	/** Byte ceiling for a durable table name, which mounts as a SQL relation. */
	tableNameBytes: 64,
	/** Byte ceiling for a durable value name, which may carry dotted grouping. */
	valueNameBytes: 128,
};

export function encodedBytes(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function encodedJsonBytes(value: unknown): number {
	return encodedBytes(JSON.stringify(value));
}
