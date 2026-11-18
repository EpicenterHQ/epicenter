import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * The principal ID Better Auth resolves for a hosted request.
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
 * The identity of the account attached to the dashboard session.
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
