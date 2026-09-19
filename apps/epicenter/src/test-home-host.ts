import { epicenterCloud } from '@epicenter/auth';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';

/** A signed-out desktop authority over a no-op native port, for server tests. */
export function createTestDesktopAuth() {
	const callbackListeners = new Set<(url: string) => void>();
	return createDesktopAuthAuthority({
		server: epicenterCloud('https://api.epicenter.so'),
		authCell: null,
		accountManagement: true,
		nativeAuthPort: {
			async closeApplications() {},
			async resumeApplications() {},
			completed: new Promise(() => undefined),
			async storeAuth() {},
			async openAuthUrl() {},
			relaunch() {},
			onAuthCallback(listener) {
				callbackListeners.add(listener);
				return () => callbackListeners.delete(listener);
			},
		},
	});
}
