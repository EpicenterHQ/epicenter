/**
 * The `#platform/os` contract.
 *
 * The shortcut contracts that used to sit here moved to `$lib/shortcuts`: they
 * were the types of two backends and a router, none of which is a build seam,
 * and keeping them in `platform/` implied a condition selects them.
 */

/**
 * Contract for `#platform/os`: host-OS identity, resolved once per build target.
 * The Tauri build reads the real OS natively; the web build infers it from the
 * user agent. Only the two facts the app actually branches on are exposed.
 */
export type Os = {
	/**
	 * An Apple platform: macOS, iOS, or iPadOS. These share the Command (⌘)
	 * primary modifier and the Option-key character layout, which is what every
	 * keyboard call site branches on. On the desktop (Tauri) build this is
	 * exactly macOS, since whispering's desktop targets are macOS, Windows, and
	 * Linux; iOS only ever appears on the web.
	 */
	isApple: boolean;
	/** Desktop Linux, excluding Android. Gates the Linux-only VAD notice. */
	isLinux: boolean;
};
