/**
 * The Epicenter host leaf: the account Home signed in to. The window holds
 * only its identity; the host carries every account request through
 * `/_epicenter/account/http`, so no credential reaches the page.
 */
import type { AuthClient } from '@epicenter/auth';
import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';

export const auth: AuthClient | undefined = createDesktopBrokerAuth({
	brokerBaseURL: window.location.origin,
});
