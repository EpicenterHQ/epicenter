import type { Command } from '$lib/commands';
// Relative, not `$lib`: the router carries no runtime `$lib` import so it stays
// free of the catalog's operations/`#platform` graph and unit-testable in
// isolation. `key-binding` itself has only type imports, so this is its lone dep.
import {
	bindingsEqual,
	type KeyBinding,
	type Reach,
	realizedReach,
} from '../utils/key-binding';
import type { ShortcutConflict, Shortcuts } from './types';

/** The reach ceiling per command, the only slice of the catalog the router reads. */
type CommandReach = { id: Command['id']; reach: Reach };

/**
 * Both stored slots for one command. A command can hold a focused binding and a
 * global binding at once (on desktop the shipped defaults already do: in-app
 * `Space` alongside global `Cmd+Shift+Space`), so the two-slot shape is the
 * honest read, not a single binding. `global` is always `null` on web, where no
 * system backend exists. See ADR-0052.
 */
type CommandBindings = {
	focused: KeyBinding | null;
	global: KeyBinding | null;
};

/**
 * The reach-routed shortcut surface: one facade over the two reach-routed
 * backends (ADR-0007), where the user never names a store. A write routes by the
 * realized reach of the key the user pressed, a read returns both slots, and a
 * clear names the slot it
 * clears (a command may hold both). The per-backend conflict policy and storage
 * scheme stay owned by the underlying surfaces; this only routes. See ADR-0052.
 */
type RoutedShortcuts = {
	/** Push every command's bindings to both backends (the global one only on desktop). */
	sync(): Promise<void>;
	/** Restore every shortcut in both stores to its default, then re-sync. */
	reset(): void;
	/** Both stored slots for a command (`global` is `null` on web). */
	current(commandId: Command['id']): CommandBindings;
	/**
	 * Persist a binding, routed to the focused or global store by its realized
	 * reach. A bare key or a chord on a focused command lands in the synced
	 * focused store; a registrable chord on a global command, on desktop,
	 * lands in the per-device global store. On web the platform ceiling clamps
	 * every write to focused.
	 */
	set(commandId: Command['id'], binding: KeyBinding): Promise<void>;
	/** Clear the named slot for a command (a no-op on the global slot on web). */
	clear(commandId: Command['id'], reach: Reach): Promise<void>;
	/**
	 * Why `binding` cannot be assigned to this command, or `null` when allowed.
	 * First the policy of the backend the key routes into (focused refuses
	 * duplicates; global also refuses reserved gestures); then, on desktop,
	 * a duplicate in the OTHER store, because the focused window runs both backends
	 * at once and the same gesture in both stores would double-fire on one keypress
	 * (ADR-0052).
	 */
	findConflict(
		commandId: Command['id'],
		binding: KeyBinding,
	): ShortcutConflict | null;
	/**
	 * The reach a candidate binding would achieve for a command on this platform.
	 * Drives the read-only reach badge ("Works in Whispering" / "Works
	 * everywhere") for both a recorded candidate and a stored slot.
	 */
	reachBadge(commandId: Command['id'], binding: KeyBinding): Reach;
};

/**
 * Compose the two reach-routed shortcut backends into one surface that routes by
 * computed reach, never by a user-chosen scope (ADR-0052). The platform ceiling
 * is read straight off the backends present: desktop supplies a `global` surface
 * and reaches `global`, web passes `null` and caps at `focused`. Because the
 * platform term of {@link realizedReach} is exactly this presence, a realized
 * reach of `global` always implies the global backend exists, so a routed write
 * can never target a missing store.
 *
 * The seam split that supplies both surfaces (the universal `focusedShortcuts`
 * and the Tauri-only `systemShortcuts`, `null` on web) lands in `shortcuts.ts`.
 * The catalog (`commands`) is injected rather than imported so the router stays
 * clear of the operations graph behind it.
 */
export function createReachRouter({
	focused,
	global,
	commands,
}: {
	focused: Shortcuts;
	global: Shortcuts | null;
	commands: readonly CommandReach[];
}): RoutedShortcuts {
	const platformReach: Reach = global ? 'global' : 'focused';
	const reachByCommandId = new Map(commands.map((c) => [c.id, c.reach]));

	function badge(commandId: Command['id'], binding: KeyBinding): Reach {
		const commandReach = reachByCommandId.get(commandId) ?? 'focused';
		return realizedReach(commandReach, binding, platformReach);
	}

	// A realized `global` reach guarantees `global` is non-null (it requires the
	// global platform ceiling, which only exists when a global backend does); the
	// `&& global` makes that invariant legible to the type checker.
	function surfaceFor(
		commandId: Command['id'],
		binding: KeyBinding,
	): Shortcuts {
		return badge(commandId, binding) === 'global' && global ? global : focused;
	}

	return {
		async sync() {
			await focused.sync();
			if (global) await global.sync();
		},
		reset() {
			focused.reset();
			global?.reset();
		},
		current(commandId) {
			return {
				focused: focused.current(commandId),
				global: global?.current(commandId) ?? null,
			};
		},
		set(commandId, binding) {
			return surfaceFor(commandId, binding).set(commandId, binding);
		},
		clear(commandId, reach) {
			const surface = reach === 'global' ? global : focused;
			return surface ? surface.clear(commandId) : Promise.resolve();
		},
		findConflict(commandId, binding) {
			const target = surfaceFor(commandId, binding);
			const within = target.findConflict(commandId, binding);
			if (within) return within;
			// On desktop the focused window runs BOTH backends at once, so a binding
			// must also not duplicate one already live in the OTHER store, or the two
			// fire on the same keypress: the cross-store double-fire the per-store
			// policies cannot see on their own. Web has no global backend, so `other`
			// is null there and this is skipped.
			const other = target === focused ? global : focused;
			if (!other) return null;
			for (const command of commands) {
				if (command.id === commandId) continue;
				const existing = other.current(command.id);
				// Test exact equality, not overlap: the in-app matcher fires on an
				// exact set match and tolerates an overlapping prefix (the focused
				// store's own policy likewise refuses only exact duplicates), so the
				// unavoidable double-fire is the identical gesture living in both
				// stores. Matching the focused backend's test keeps the two consistent.
				if (existing && bindingsEqual(existing, binding)) {
					return { kind: 'crossStore', commandId: command.id };
				}
			}
			return null;
		},
		reachBadge(commandId, binding) {
			return badge(commandId, binding);
		},
	};
}
