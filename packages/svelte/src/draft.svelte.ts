/**
 * The folder shows what landed; a draft holds what was typed until it lands.
 * Changes debounce by default for 1000 ms. Timed sends never overlap: an
 * older save answers before a timed newer send. Teardown, pagehide, hidden
 * visibility, beforeunload, and folder close send the newest
 * unsent value synchronously, even with a save out, then leave ordering to the
 * folder's queue. Failed input remains visible for retry or discard.
 */
import { onDestroy } from 'svelte';
import { Err, type Result } from 'wellcrafted/result';

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
	let due = false;
	let active = true;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clearTimer() {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	function send(immediate: boolean, retry = false) {
		const sent = current;
		if (sent === null || (!retry && sent === lastSent)) return;
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
			inFlight--;
			if (!active) return;
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
		};
		void answer.then(apply, (cause: unknown) => {
			// SAFETY: a rejected save failure uses the same error channel.
			apply(Err(cause as E));
		});
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
		window.addEventListener('beforeunload', flush);
		window.addEventListener('epicenter:folder-close', flush);
		document.addEventListener('visibilitychange', hidden);
		return () => {
			window.removeEventListener('pagehide', flush);
			window.removeEventListener('beforeunload', flush);
			window.removeEventListener('epicenter:folder-close', flush);
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
