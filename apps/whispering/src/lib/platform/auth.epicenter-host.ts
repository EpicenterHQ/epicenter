import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';

/** Window-local Account capability; the host retains credentials and brokers transport. */
export const authClient = createDesktopBrokerAuth({
	brokerBaseURL: window.location.origin,
});
