import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * The authenticated principal id, and the partition key everything derives from.
 *
 * This identity leaf exists because `@epicenter/data` and
 * `@epicenter/auth` both need it and neither depends on the other: the store
 * opens a local database with no auth at all (`openLocal`), and the auth client
 * runs with no store (the hosted dashboard). A leaf is what two siblings share.
 *
 * On hosted Cloud, this is the principal Better Auth resolved for the request.
 * On a self-hosted instance, this is the literal {@link INSTANCE_PRINCIPAL_ID}.
 * By definition, every server path, R2 key, Durable Object name, local database
 * name, and HKDF derivation label uses this value as the partition key.
 *
 * The instance constant's bytes are pinned. Changing them changes HKDF labels,
 * R2 prefixes, Durable Object names, and IndexedDB keys.
 *
 * The type is declared first and the validator is annotated to it, so the brand
 * is written once and the schema conforms to it rather than the reverse. Both
 * carry one PascalCase name. Use {@link PrincipalId} directly inside schemas
 * (`principalId: PrincipalId`); at trusted call sites brand a known `string`
 * via {@link asPrincipalId}.
 */
export type PrincipalId = string & Brand<'PrincipalId'>;
export const PrincipalId = type('string').as<PrincipalId>();

/**
 * The stable identity of one account, without credentials or network access.
 * A local library has no account and is represented by `null` at its opener.
 */
export type AccountIdentity = {
	readonly authorityId: string;
	readonly principalId: PrincipalId;
};

/** The selected library and the person who owns its local resources. */
export type LibraryReplicaIdentity =
	| { library: 'local' }
	| { library: 'personal' | 'shared'; account: AccountIdentity };

/** Validate a credential-free library replica received across a runtime boundary. */
export function isLibraryReplica(
	value: unknown,
): value is LibraryReplicaIdentity {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		!('library' in value)
	)
		return false;
	if (value.library === 'local') return !('account' in value);
	if (value.library !== 'personal' && value.library !== 'shared') return false;
	if (
		!('account' in value) ||
		typeof value.account !== 'object' ||
		value.account === null ||
		Array.isArray(value.account)
	)
		return false;
	const account = value.account;
	const segment = (value: unknown) =>
		typeof value === 'string' &&
		value !== '' &&
		value !== '.' &&
		value !== '..' &&
		!/[\\/\p{Cc}]/u.test(value);
	return (
		'authorityId' in account &&
		'principalId' in account &&
		segment(account.authorityId) &&
		segment(account.principalId)
	);
}

/** Capture only addressing fields, never credentials or a mutable Account object. */
export function captureLibraryReplica(
	replica: LibraryReplicaIdentity,
): LibraryReplicaIdentity {
	if (!isLibraryReplica(replica))
		throw new TypeError('Invalid library replica.');
	if (replica.library === 'local') return Object.freeze({ library: 'local' });
	return Object.freeze({
		library: replica.library,
		account: Object.freeze({
			authorityId: replica.account.authorityId,
			principalId: replica.account.principalId,
		}),
	});
}

/**
 * Syntactic sugar for `value as PrincipalId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as PrincipalId` appears.
 */
export const asPrincipalId = (value: string): PrincipalId =>
	value as PrincipalId;

/** Byte-pinned principal id for the single-partition self-hosted instance. */
export const INSTANCE_PRINCIPAL_ID = asPrincipalId('instance');
