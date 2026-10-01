/** Reach routing, backend delegation, and cross-store conflict behavior. */
import { expect, test } from 'bun:test';
import type { KeyBinding } from '$lib/utils/key-binding';
import { createReachRouter } from './reach-router';
import type { ShortcutConflict, Shortcuts } from './types';

/**
 * The catalog slice the router reads, with a `focused`-ceiling command alongside
 * the `global` ones so a chord routes into different stores by command reach: a
 * `focused` command clamps into the focused store, a `global` command routes to
 * the global store. The full command-ceiling clamp (a chord on a `focused`
 * command) is pinned by `realizedReach`'s own tests, so here it only needs to
 * prove the router consults `command.reach`. `as const` keeps the literal ids
 * and reaches; each router call checks the shape against the production API.
 */
const CATALOG = [
	{ id: 'toggleManualRecording', reach: 'global' },
	{ id: 'pushToTalk', reach: 'global' },
	{ id: 'openSettings', reach: 'focused' },
	{ id: 'cancelRecording', reach: 'global' },
] as const;

/**
 * A `Shortcuts` test double that stores bindings in a map and records the calls
 * the router delegates to it. `conflict` is the canned `findConflict` result, so
 * a test can prove which backend a conflict check was routed into.
 */
function fakeShortcuts(conflict: ShortcutConflict | null = null) {
	const store = new Map<string, KeyBinding | null>();
	const calls = {
		set: [] as Array<[string, KeyBinding]>,
		clear: [] as string[],
		sync: 0,
		reset: 0,
	};
	const surface: Shortcuts = {
		async sync() {
			calls.sync++;
		},
		reset() {
			calls.reset++;
		},
		current: (id) => store.get(id) ?? null,
		async set(id, binding) {
			store.set(id, binding);
			calls.set.push([id, binding]);
		},
		async clear(id) {
			store.set(id, null);
			calls.clear.push(id);
		},
		findConflict: () => conflict,
	};
	return { surface, store, calls };
}

const CHORD: KeyBinding = { modifiers: ['meta', 'shift'], keys: ['space'] };
const BARE: KeyBinding = { modifiers: [], keys: ['space'] };
const FN_HOLD: KeyBinding = { modifiers: ['fn'], keys: [] };

test('a chord on a global command routes the write to the global store (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.set('toggleManualRecording', CHORD);

	expect(global.calls.set).toEqual([['toggleManualRecording', CHORD]]);
	expect(focused.calls.set).toEqual([]);
});

test('a bare key on a global command routes to the focused store (key ceiling, desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.set('toggleManualRecording', BARE);

	expect(focused.calls.set).toEqual([['toggleManualRecording', BARE]]);
	expect(global.calls.set).toEqual([]);
});

test('a refused Fn hold is not global and routes to the focused store (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	// An Fn hold is not a registrable chord (ADR-0117), so its key capability caps
	// at focused; the badge is 'focused' and the write routes to the focused store,
	// never claiming "Works everywhere".
	expect(router.reachBadge('pushToTalk', FN_HOLD)).toBe('focused');

	await router.set('pushToTalk', FN_HOLD);
	expect(focused.calls.set).toEqual([['pushToTalk', FN_HOLD]]);
	expect(global.calls.set).toEqual([]);
});

test('web has no global backend, so the platform ceiling clamps every write to focused', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	// A chord buys nothing on web: min(global, global, focused) = focused.
	expect(router.reachBadge('toggleManualRecording', CHORD)).toBe('focused');

	await router.set('toggleManualRecording', CHORD);
	expect(focused.calls.set).toEqual([['toggleManualRecording', CHORD]]);
});

test('clear targets the named slot', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.clear('toggleManualRecording', 'global');
	expect(global.calls.clear).toEqual(['toggleManualRecording']);
	expect(focused.calls.clear).toEqual([]);

	await router.clear('toggleManualRecording', 'focused');
	expect(focused.calls.clear).toEqual(['toggleManualRecording']);
});

test('clearing the global slot is a no-op on web', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	await router.clear('toggleManualRecording', 'global');
	expect(focused.calls.clear).toEqual([]);
});

test('current returns both slots', () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	focused.store.set('toggleManualRecording', BARE);
	global.store.set('toggleManualRecording', CHORD);
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	expect(router.current('toggleManualRecording')).toEqual({
		focused: BARE,
		global: CHORD,
	});
});

test('current reports a null global slot on web', () => {
	const focused = fakeShortcuts();
	focused.store.set('toggleManualRecording', BARE);
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	expect(router.current('toggleManualRecording')).toEqual({
		focused: BARE,
		global: null,
	});
});

test('findConflict is checked against the store the key would route into', () => {
	const focused = fakeShortcuts({ kind: 'duplicate', commandId: 'pushToTalk' });
	const global = fakeShortcuts({
		kind: 'reserved',
		reason: 'reserved by macOS',
	});
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	// A chord routes global, so the global policy answers.
	expect(router.findConflict('toggleManualRecording', CHORD)).toEqual({
		kind: 'reserved',
		reason: 'reserved by macOS',
	});
	// A bare key routes focused, so the focused policy answers.
	expect(router.findConflict('toggleManualRecording', BARE)).toEqual({
		kind: 'duplicate',
		commandId: 'pushToTalk',
	});
});

test('findConflict refuses a binding that would double-fire across both stores (desktop)', () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	// openSettings (focused ceiling) already holds the chord in the focused store.
	focused.store.set('openSettings', CHORD);
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	// The same chord on a global command routes into the global store, but it would
	// still fire in the focused window where openSettings is live, so it is refused,
	// naming the command it collides with.
	expect(router.findConflict('cancelRecording', CHORD)).toEqual({
		kind: 'crossStore',
		commandId: 'openSettings',
	});
});

test('the cross-store check refuses only an identical gesture, not a mere overlap (desktop)', () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	// openSettings holds bare Space in the focused store.
	focused.store.set('openSettings', BARE);
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	// Cmd+Shift+Space (routed global) merely *contains* bare Space; pressing it
	// never produces the exact `{Space}` held-set the in-app matcher needs, so it
	// does not double-fire and is allowed. The focused backend itself refuses only
	// exact duplicates, and the cross-store check matches that.
	expect(router.findConflict('cancelRecording', CHORD)).toBeNull();
});

test('the cross-store check is desktop-only: web has no other store to span', () => {
	const focused = fakeShortcuts();
	focused.store.set('openSettings', CHORD);
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	// On web there is no global backend, so a global command clamps to focused and
	// its within-store policy (a real backend) owns the collision; the router adds
	// no cross-store check. The fake reports no within conflict, so null.
	expect(router.findConflict('cancelRecording', CHORD)).toBeNull();
});

test('sync pushes both backends; reset resets both (desktop)', async () => {
	const focused = fakeShortcuts();
	const global = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: global.surface,
		commands: CATALOG,
	});

	await router.sync();
	expect(focused.calls.sync).toBe(1);
	expect(global.calls.sync).toBe(1);

	router.reset();
	expect(focused.calls.reset).toBe(1);
	expect(global.calls.reset).toBe(1);
});

test('sync and reset touch only the focused backend on web', async () => {
	const focused = fakeShortcuts();
	const router = createReachRouter({
		focused: focused.surface,
		global: null,
		commands: CATALOG,
	});

	await router.sync();
	router.reset();

	expect(focused.calls.sync).toBe(1);
	expect(focused.calls.reset).toBe(1);
});
