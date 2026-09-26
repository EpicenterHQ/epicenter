import type { Os } from './types';

// The web build cannot ask the OS natively, so it infers the host family from
// the user agent. Only the two facts the app branches on are exposed; iPadOS
// reports as Mac with a touch point count, which the `isApple` check covers.
const ua = globalThis.navigator?.userAgent ?? '';

export const os: Os = {
	isApple: /Mac|iPhone|iPad|iPod/.test(ua),
	isLinux: /Linux|X11/.test(ua) && !/Android/.test(ua),
};
