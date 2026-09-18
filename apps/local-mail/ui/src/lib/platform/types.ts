import type { AuthorizationRequest } from '@epicenter/local-mail/oauth';

/** Consent returns to the primary document; callbacks open no library. */
export type GmailAuthorization = {
	authorize(request: AuthorizationRequest, signal: AbortSignal): Promise<URL>;
};
