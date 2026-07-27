/**
 * The shared address vocabulary and its byte ceilings.
 *
 * The scalar wire protocol itself lives in `./v1/`, which is the one place a
 * fact, an intent, or an operation is defined. This barrel is what survives of
 * the combined exchange it replaced: the structured address grammar, its
 * ceilings, and the canonical JSON encoder, all of which outlived that protocol
 * because they were never part of it.
 *
 * Address shape has exactly one owner (`./addresses.ts`), shared by the kernel,
 * the replica, the authority, and the inspection host, so a coordinate rename
 * is one edit rather than four that can drift.
 */
export {
	type Address,
	type AddressByteCeilings,
	AddressSchema,
	addressesEqual,
	addressKey,
	isAddress,
	isAdmissibleAddress,
	isNamespace,
	isRowAddress,
	isRuntimeId,
	isTableName,
	isValueAddress,
	isValueName,
	type RowAddress,
	RowAddressSchema,
	SQLITE_UNUSABLE_AS_RELATION_NAME,
	type ValueAddress,
	ValueAddressSchema,
} from './addresses.js';
export {
	DATA_ADDRESS_CEILINGS,
	encodedBytes,
	encodedJsonBytes,
} from './admission.js';
export { canonicalJson, sha256Hex } from './canonical.js';
export {
	isJsonObject,
	isJsonValue,
	type JsonObject,
	type JsonValue,
} from './v1/json.js';
