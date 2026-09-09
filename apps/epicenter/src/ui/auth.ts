import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';

/** Home reads the same secret-free boot Account as application windows. */
export const auth = createDesktopBrokerAuth({
	brokerBaseURL: window.location.origin,
});
