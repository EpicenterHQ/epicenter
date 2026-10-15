import { PrincipalId } from '@epicenter/principal';
import { type } from 'arktype';

/** Epicenter's principal projection. The self-hosted principal has no email. */
export const Principal = type({
	'+': 'delete',
	id: PrincipalId,
	'email?': 'string',
});
export type Principal = typeof Principal.infer;

/** Resource projection served by /api/session; Better Auth owns session rows. */
export const ApiSessionResponse = type({
	'+': 'delete',
	principalId: PrincipalId,
	'email?': 'string',
});
export type ApiSessionResponse = typeof ApiSessionResponse.infer;
