/**
 * The folder shows what landed; a draft holds what was typed until it lands.
 * Changes debounce by default for 1000 ms. Timed sends never overlap: an
 * older save answers before a timed newer send. Teardown, pagehide, hidden
 * visibility, and beforeunload send the newest unsent value synchronously,
 * even with a save out, then leave ordering to the folder's queue. Failed
 * input remains visible for retry or discard. A draft answers `beforeunload`
 * as unsure while its save is out or failed, so the page asks before leaving.
 */
import { onDestroy } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';

export function draft<T, E>(
	source: () => T,
	save: (value: T) => Promise<Result<unknown, E>>,
	{ delay = 1000 }: { delay?: number } = {},
) {
	let typed = $state<{ value: T } | null>(null);
	// Teardown can no longer read Svelte state, so keep the latest value in this closure.
	let current: { value: T } | null = null;
	let error = $state<E | null>(null);
	let lastSent: { value: T } | null = null;
	let inFlight = 0;
	const pending = new Map<{ value: T }, Promise<Result<unknown, E>>>();
	let due = false;
	let active = true;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function send(
		immediate: boolean,
		retry = false,
	): Promise<Result<unknown, E>> | undefined {
		const sent = current;
		if (sent === null || (!retry && sent === lastSent)) return undefined;
		if (!immediate && inFlight > 0) return;
		lastSent = sent;
		inFlight++;
		let answer: Promise<Result<unknown, E>>;
		try {
			answer = save(sent.value);
		} catch (cause) {
			// SAFETY: a thrown save failure is presented through the draft's error channel.
			answer = Promise.resolve(Err(cause as E));
		}
		const apply = (result: Result<unknown, E>) => {
			pending.delete(sent);
			inFlight--;
			if (!active) return result;
			if (current === sent) {
				if (result.error === null) {
					current = null;
					typed = null;
				} else error = result.error;
			}
			if (due && inFlight === 0) {
				due = false;
				send(false);
			}
			return result;
		};
		const settled = answer.then(apply, (cause: unknown) => {
			// SAFETY: a rejected save failure uses the same error channel.
			return apply(Err(cause as E));
		});
		pending.set(sent, settled);
		return settled;
	}

	function flush() {
		if (!active) return;
		clearTimer();
		due = false;
		send(true);
	}

	function set(value: T) {
		if (!active) return;
		current = { value };
		typed = current;
		error = null;
		clearTimer();
		due = false;
		timer = setTimeout(() => {
			timer = undefined;
			due = true;
			if (inFlight === 0) {
				due = false;
				send(false);
			}
		}, delay);
	}

	async function land(): Promise<Result<void, E>> {
		if (!active) return Ok(undefined);
		clearTimer();
		due = false;
		while (active && current !== null) {
			const sent = current;
			const ongoing = pending.get(sent);
			if (ongoing !== undefined) {
				const result = await ongoing;
				if (current === sent && result.error !== null) return Err(result.error);
				continue;
			}
			if (sent === lastSent) return error === null ? Ok(undefined) : Err(error);
			if (pending.size > 0) {
				await Promise.all(pending.values());
				continue;
			}
			const result = await send(true);
			if (
				current === sent &&
				result?.error !== null &&
				result?.error !== undefined
			)
				return Err(result.error);
		}
		return Ok(undefined);
	}

	/** Leaving sends what was typed, and is unsure while that save is out or failed. */
	function unload(event: Event) {
		flush();
		if (inFlight > 0 || error !== null) event.preventDefault();
	}

	onDestroy(() => {
		flush();
		active = false;
		clearTimer();
	});

	$effect(() => {
		const hidden = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		window.addEventListener('pagehide', flush);
		window.addEventListener('beforeunload', unload);
		document.addEventListener('visibilitychange', hidden);
		return () => {
			window.removeEventListener('pagehide', flush);
			window.removeEventListener('beforeunload', unload);
			document.removeEventListener('visibilitychange', hidden);
		};
	});

	return {
		get value() {
			return typed === null ? source() : typed.value;
		},
		set value(value: T) {
			set(value);
		},
		get error() {
			return error;
		},
		set,
		land,
		retry() {
			if (!active || current === null) return;
			error = null;
			clearTimer();
			due = false;
			if (inFlight > 0) {
				lastSent = null;
				due = true;
			} else send(true, true);
		},
		discard() {
			if (!active) return;
			clearTimer();
			due = false;
			current = null;
			typed = null;
			error = null;
		},
	};
}
