import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * The authenticated principal id, and the partition key everything derives from.
 *
 * This identity leaf exists because `@epicenter/app/store` and
 * `@epicenter/auth` both need it and neither depends on the other: the store
 * opens a local database with no auth at all (`openApp(definition)`), and the auth client
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
 * A device store may use this identity without any transport or synchronization.
 */
export type AccountIdentity = {
	readonly authorityId: string;
	readonly principalId: PrincipalId;
};

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
