/**
 * `#platform/auth` in Capture's desktop window: no sign-in. Capture makes
 * no inference calls, and Epicenter syncs the window's folder, so the
 * window never signs in (decision 77: sign-in grants capabilities, never
 * storage).
 */
import type { CaptureAuth } from './auth.js';

/** The desktop window signs in to nothing. */
export const webAuth = (): CaptureAuth | null => null;
