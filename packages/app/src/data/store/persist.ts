/**
 * Ask the browser not to evict this origin, once, and remember what it said.
 *
 * The one measure that moves the failure this whole design is careful about,
 * and the only one that touches the case nothing else can see.
 *
 * ## Why it matters more than any surface
 *
 * A durable record can report a write it was refused. It cannot report an
 * EVICTION, because there is no event for one: an origin's storage is
 * reclaimed wholesale, IndexedDB and the Cache API together, and an
 * application learns about it by reading and finding nothing. On the next
 * boot the chain is empty, the health bit is green, and nothing distinguishes
 * that from a device that never had the data. `persisted()` is the only thing
 * that makes it unlikely.
 *
 * It also covers a second sweep with no signal: Safari clears script-writable
 * storage after seven days without interaction, and a persisted origin is
 * exempt.
 *
 * ## Why it lives here rather than in an application
 *
 * Every offline-first library in the neighbourhood documents this as something
 * the application must remember to do, and none of them does it. RxDB says to
 * call it; Dexie does not mention it; `y-indexeddb` neither calls it nor has
 * an error channel at all. Leaving it to each app is how it never happens, and
 * the browser openers are the one place that knows storage is about to matter.
 *
 * ## What the answer means
 *
 * Firefox prompts a person. Chrome and Safari decide from engagement
 * heuristics without asking, so an installed desktop shell with repeat visits
 * is likely to be granted and a first-visit tab is likely not. A refusal is
 * not a failure and must not be treated as one: it is the ordinary state of a
 * page somebody has just opened.
 */

/** The slice of the Storage API this needs, declared rather than imported. */
type StorageManager = {
	persisted?: () => Promise<boolean>;
	persist?: () => Promise<boolean>;
};

function storage(): StorageManager | undefined {
	return (globalThis as { navigator?: { storage?: StorageManager } }).navigator
		?.storage;
}

/**
 * Whether this origin is exempt from eviction, asking for it if it is not.
 *
 * Never throws and never rejects: a runtime without the Storage API, a browser
 * that refuses, and a browser that says yes are three ordinary outcomes, and a
 * store must open in all of them.
 */
export async function requestPersistentStorage(): Promise<boolean> {
	const manager = storage();
	if (manager === undefined) return false;
	try {
		if ((await manager.persisted?.()) === true) return true;
		return (await manager.persist?.()) === true;
	} catch {
		// A permissions policy can reject the call outright. That is a refusal
		// like any other, not a reason to fail a boot.
		return false;
	}
}
