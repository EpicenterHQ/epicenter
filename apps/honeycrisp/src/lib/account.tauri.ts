/**
 * `#platform/account` in the desktop window: none. The window never signs
 * in; Epicenter syncs its folder once the person asks.
 */
import type { CallbackAuthClient } from '@epicenter/account';

export function connectAccount(): CallbackAuthClient | null {
	return null;
}
