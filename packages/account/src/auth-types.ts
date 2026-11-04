import { type } from 'arktype';
import { PrincipalId } from './principal.js';

/** Epicenter's principal projection. The self-hosted principal has no email. */
export const Principal = type({
	'+': 'delete',
	id: PrincipalId,
	'email?': 'string',
});
export type Principal = typeof Principal.infer;
