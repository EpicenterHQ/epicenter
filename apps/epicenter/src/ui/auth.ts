import {
	createDesktopBrokerAuth,
	readDesktopAuthBootstrap,
} from '@epicenter/auth/desktop';

export const bootstrap = readDesktopAuthBootstrap();

/** Home reads the same secret-free boot Account as application windows. */
export const auth = createDesktopBrokerAuth({
	bootstrap,
	brokerBaseURL: window.location.origin,
});
