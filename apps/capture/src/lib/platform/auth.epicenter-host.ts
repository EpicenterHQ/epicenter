import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';

export const auth = createDesktopBrokerAuth({
	brokerBaseURL: window.location.origin,
});
