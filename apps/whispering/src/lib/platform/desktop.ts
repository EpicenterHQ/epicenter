/**
 * `#platform/desktop` in a browser: there is no desktop shell, so every
 * page renders the browser's root and settings.
 */
import type { DesktopShell } from './types.js';

export const desktop: DesktopShell | null = null;
