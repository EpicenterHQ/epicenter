/**
 * @fileoverview The one place this package knows it is talking to Tauri.
 *
 * Everything above this file speaks in capabilities. Everything below it is
 * `@tauri-apps/api`, which is the host's own public transport: the same
 * `invoke` and `listen` Epicenter's generated bindings use. This package does
 * not reimplement either against `window.__TAURI_INTERNALS__`, because a
 * private global is a worse contract than a published one and would go stale
 * silently.
 *
 * It does *read* that global, for exactly one purpose. `invoke` dereferences
 * `window.__TAURI_INTERNALS__` when called, so its presence is precisely the
 * question "would this call reach a host". Asking it first is what turns a
 * plain browser tab from a thrown `TypeError` into a typed
 * `HostUnavailable`. The read is lazy, so a module imported before the host
 * finishes injecting the global is not permanently poisoned.
 *
 * # Three kinds of no
 *
 * A host that declines can decline in three ways, and they are told apart by
 * the shape of what comes back rather than by matching on message text:
 *
 * - **A plain string.** Tauri serializes framework failures to strings, and one
 *   of them is its access-control layer refusing to route the call. Only that
 *   one is `CapabilityUnavailable`; see `REFUSED_MARKER` below.
 * - **A tagged object.** The command ran and reported a typed failure. It is
 *   handed back to the capability that asked for it, which knows which of its
 *   own names it maps to.
 * - **Anything else**, including an `Error` instance. Something broke that is
 *   not part of the contract. It travels as an opaque cause and each capability
 *   folds it into its own `*Failed` variant, never into an "unavailable".
 *
 * # Events are scoped to this window, never to "any"
 *
 * Subscriptions go through `getCurrentWebviewWindow().listen`, not the bare
 * `listen` from `@tauri-apps/api/event`, and the difference is isolation rather
 * than style. Bare `listen` registers the target `Any`, and Tauri's dispatcher
 * short-circuits an `Any` listener past the emit's own filter
 * (`match_any_or_filter`, `event/listener.rs`). A host that carefully emits to
 * one owner's label would still reach every app window that happened to
 * subscribe. Scoping to the current webview window registers
 * `WebviewWindow { label }`, which the emit filter matches only when the label
 * is this window's, so an app hears about its own recordings and no one
 * else's.
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type HostError, HostErrors } from './errors.js';

/**
 * A rejection the host produced that this layer will not interpret: either a
 * typed failure from the command itself or something unrecognized. The
 * capability that made the call owns the mapping, because only it knows which
 * failures its own operation can produce.
 *
 * @internal Never escapes the package: every call site maps it.
 */
export type HostRejection = { readonly domain: unknown };

/** @internal */
export function isHostRejection(
	error: HostError | HostRejection,
): error is HostRejection {
	return 'domain' in error;
}

/**
 * Whether an Epicenter host is reachable from here.
 *
 * `__TAURI_INTERNALS__` is present exactly when this document was served by an
 * Epicenter host, so this one read answers two questions: whether an `invoke`
 * would reach a command, and whether the same-origin data route exists at all.
 * `data.ts` asks the second and reaches this file for the answer, because a
 * second copy of the read is a second place to change if the host ever
 * announces itself differently.
 *
 * The read is lazy, so a module imported before the host finishes injecting the
 * global is not permanently poisoned.
 *
 * @internal
 */
export function hostIsReachable(): boolean {
	if (typeof window === 'undefined') return false;
	const internals = Reflect.get(window, '__TAURI_INTERNALS__');
	return typeof internals === 'object' && internals !== null;
}

/**
 * Invoke a host command.
 *
 * @internal
 */
export async function callHost<T>(
	operation: string,
	command: string,
	args?: Record<string, unknown>,
): Promise<Result<T, HostError | HostRejection>> {
	if (!hostIsReachable()) return HostErrors.HostUnavailable({ operation });
	try {
		return Ok(await invoke<T>(command, args));
	} catch (rejection) {
		return classify(operation, rejection);
	}
}

/**
 * Subscribe to a host event, and hand back the call that ends the subscription.
 *
 * @internal
 */
export async function observeHost<TPayload>(
	operation: string,
	event: string,
	handler: (payload: TPayload) => void,
): Promise<Result<() => void, HostError | HostRejection>> {
	if (!hostIsReachable()) return HostErrors.HostUnavailable({ operation });
	try {
		// Two upstream lifecycle facts worth stating, because neither is
		// fixable from here and both would otherwise look like oversights.
		//
		// `listen` registers the handler on the page (`transformCallback`)
		// *before* it asks the host to start sending, and it has no cleanup
		// path if that ask is refused. So a failed subscription strands one
		// closure. Reaching into `__TAURI_INTERNALS__` to unregister it would
		// trade a published API for a private one to reclaim one function, and
		// the failure it cleans up after is a missing grant, which is a build
		// mistake that fails once at startup rather than in a loop.
		const unlisten = await getCurrentWebviewWindow().listen<TPayload>(
			event,
			({ payload }) => handler(payload),
		);
		// And unsubscribing is two steps that can half-succeed: the page's
		// handler is dropped first, then the host is told to stop sending. If
		// that second call fails, the host keeps a listener pointed at a
		// handler that no longer exists, and it will keep doing so until the
		// window is destroyed.
		//
		// This still hands back `() => void` rather than something a caller
		// awaits and checks. A caller running this has already let go of the
		// subscription; there is no repair it could attempt and no decision the
		// outcome would change, and an app-window build grants the unlisten it
		// needs, so the residue is a host-side record nobody reads.
		return Ok(() => {
			void Promise.resolve(unlisten()).catch(() => {});
		});
	} catch (rejection) {
		return classify(operation, rejection);
	}
}

/**
 * Fire a host command whose outcome nobody reads.
 *
 * Used only where the operation is defined to have no outcome. It swallows
 * every failure, including the absence of a host, so it can never produce an
 * unhandled rejection in a browser tab.
 *
 * @internal
 */
export function nudgeHost(command: string, args?: Record<string, unknown>) {
	if (!hostIsReachable()) return;
	// `invoke` is async, so every failure arrives as a rejection. Swallowing it
	// here is the whole contract: this call has no outcome, so there is nowhere
	// to report to, and leaving it unhandled would surface in a caller's error
	// reporting as something they cannot act on.
	void invoke(command, args).catch(() => {});
}

/**
 * The marker every access-control refusal carries, and nothing else does.
 *
 * Tauri writes all four of its refusals in one module (`ipc/authority.rs`) and
 * every one of them says the command is "not allowed": on no context at all, on
 * this window and webview, on this origin, or with the permissions it found.
 * They are diagnostics for a developer, not user-facing copy, so they are not
 * localized and not formatted per platform.
 *
 * This is the conservative half of a deliberately asymmetric test. A refusal
 * whose wording changes in a future Tauri stops being reported as
 * `CapabilityUnavailable` and becomes an ordinary failure, which loses a
 * distinction. The reverse mistake would state that an app was never granted an
 * operation when it was, which is a claim someone would act on. Losing a
 * distinction is the safe direction to fail.
 */
const REFUSED_MARKER = 'not allowed';

function classify(
	operation: string,
	rejection: unknown,
): Err<HostError | HostRejection> {
	// Checked before the tagged-object test on purpose: an `Error` carries a
	// `name` too, and treating `TypeError` as a command's typed failure would be
	// exactly the "unknown bug becomes ordinary unavailability" mistake.
	if (rejection instanceof Error) return Err({ domain: rejection });
	// A string means the host rejected the call rather than the command
	// reporting a failure of its own: these commands' failures are tagged
	// objects. But it does not mean the call was refused. Tauri serializes
	// several framework failures to strings through the same path, and two of
	// them are ordinary bugs rather than missing authority: arguments this
	// client sent that the command could not deserialize
	// (`Error::InvalidArgs`), and host state that was never registered
	// (`State::from_command`). Calling either of those "unavailable" would
	// describe a mistake as a permission.
	if (typeof rejection === 'string') {
		return rejection.includes(REFUSED_MARKER)
			? HostErrors.CapabilityUnavailable({ operation, cause: rejection })
			: Err({ domain: rejection });
	}
	return Err({ domain: rejection });
}

/**
 * Read a rejection as a tagged host failure, or `undefined` when it is not one.
 *
 * @internal
 */
export function taggedName(domain: unknown): string | undefined {
	if (typeof domain !== 'object' || domain === null) return undefined;
	const name = Reflect.get(domain, 'name');
	return typeof name === 'string' ? name : undefined;
}

/**
 * The human-readable half of a tagged host failure, for callers that quote it.
 *
 * @internal
 */
export function taggedMessage(domain: unknown): string {
	if (typeof domain !== 'object' || domain === null) return String(domain);
	const message = Reflect.get(domain, 'message');
	return typeof message === 'string' ? message : String(domain);
}
