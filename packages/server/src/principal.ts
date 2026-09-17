/** Historical principal-scoped data authority and generation ledger addresses. */
import type { PrincipalId } from '@epicenter/principal';

/**
 * Durable Object name template for one partition's store of one data domain.
 *
 * One Durable Object per `(principalId, dataId)` rather than per principal,
 * because ADR-0215 makes one data domain ONE document and the authority's log
 * is that document's: two data domains sharing a log would interleave positions
 * neither could read past. The `principalId` segment is the partition, so a
 * client that names another data id still lands inside its OWN partition.
 *
 * The `dataId` is the durable data domain's identity and is the same identifier
 * the replica derives its local storage from. An application's default data id
 * commonly matches its application id, but the store does not require that
 * relationship and can be opened by another application.
 *
 * The resource segment is `data` rather than `stores` (ADR-0276). A store is the
 * runtime object a client holds; what is addressed here is one data definition,
 * the value of `defineData({ id })`. It is a sibling of `blobs` under the same
 * partition, which is the whole job `stores` was doing.
 *
 * The name carries the GENERATION (ADR-0276, ADR-0292), and that is what makes
 * the object an exact address rather than a mutable one: a generation is
 * created once and never mutated in place, so an object at this name holds one
 * history and a replica that reached it cannot be carrying another's bytes.
 * The document identity stamp existed to answer that question and is retired
 * with it.
 *
 * Nothing anywhere maps an old name to a new one: the name is derived on both
 * halves from values they already hold, so a rename strands data rather than
 * requiring a migration.
 */
export type StoreCollectionDoName = `principals/${string}/data/${string}`;
export type StoreAuthorityDoName =
	`${StoreCollectionDoName}/generations/${number}`;

/**
 * Durable name of one partition's generations ledger for one database.
 *
 * The bare name the authority used to hold. It holds numbers now: which
 * generations exist, which is what makes one addressable at all (ADR-0293).
 */
export function storeCollectionName(
	principalId: PrincipalId,
	dataId: string,
): StoreCollectionDoName {
	return `principals/${principalId}/data/${dataId}`;
}

/** Durable name of one partition's authority for one database generation. */
export function storeAuthorityName(
	principalId: PrincipalId,
	dataId: string,
	generation: number,
): StoreAuthorityDoName {
	return `principals/${principalId}/data/${dataId}/generations/${generation}`;
}
