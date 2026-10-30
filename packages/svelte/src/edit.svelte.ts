/** An edit shows typed text until its latest immediate save answers. */
import { onDestroy } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';

export function edit<T, E>(
	source: () => T,
	save: (value: T) => Promise<Result<unknown, E>>,
) {
	let typed = $state<{ value: T } | null>(null);
	let error = $state<E | null>(null);
	let lastSave: Promise<Result<unknown, E>> | undefined;
	let active = true;

	function send(value: T) {
		let answer: Promise<Result<unknown, E>>;
		try {
			answer = save(value);
		} catch (cause) {
			// SAFETY: a thrown save failure is presented through the edit's error channel.
			answer = Promise.resolve(Err(cause as E));
		}
		const settled = answer.then(
			(result) => result,
			(cause: unknown) => {
				// SAFETY: a rejected save failure uses the same error channel.
				return Err(cause as E);
			},
		);
		lastSave = settled;
		void settled.then((result) => {
			if (!active || lastSave !== settled) return;
			if (result.error === null) {
				typed = null;
			} else error = result.error;
		});
	}

	function set(value: T) {
		if (!active) return;
		typed = { value };
		error = null;
		send(value);
	}

	async function landed(): Promise<Result<void, E>> {
		while (active && typed !== null) {
			const answer = lastSave;
			if (answer === undefined) return Ok(undefined);
			const result = await answer;
			if (answer !== lastSave) continue;
			return result.error === null ? Ok(undefined) : Err(result.error);
		}
		return Ok(undefined);
	}

	onDestroy(() => {
		active = false;
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
		landed,
		retry() {
			if (!active || typed === null) return;
			error = null;
			send(typed.value);
		},
		discard() {
			if (!active) return;
			typed = null;
			error = null;
			lastSave = undefined;
		},
	};
}
