import type { PrincipalId } from '@epicenter/principal';

/** Serializable identity reported by a credential authority or cookie session.
 * Desktop bootstraps carry this projection, never an Account's functions or credentials. */
export type AuthIdentityState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; principalId: PrincipalId }
	| { status: 'reauth-required'; principalId: PrincipalId };
