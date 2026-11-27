/*
	Installed from @ieedan/shadcn-svelte-extras
	Modified to support injectable copy function for cross-platform compatibility
*/

import type { CopyFn } from '../copy-button/types.js';

type Options = {
	/** The time before the copied status is reset. */
	delay: number;
	/** Custom copy function. Defaults to navigator.clipboard.writeText. */
	copyFn: CopyFn;
};

const defaultCopyFn: CopyFn = (text) => navigator.clipboard.writeText(text);

/** Use this hook to copy text to the clipboard and show a copied state.
 *
 * ## Usage
 * ```svelte
 * <script lang="ts">
 * 		import { UseClipboard } from "$lib/hooks/use-clipboard.svelte";
 *
 * 		const clipboard = new UseClipboard();
 * </script>
 *
 * <button onclick={clipboard.copy('Hello, World!')}>
 *     {#if clipboard.copied === 'success'}
 *         Copied!
 *     {:else if clipboard.copied === 'failure'}
 *         Failed to copy!
 *     {:else}
 *         Copy
 *     {/if}
 * </button>
 * ```
 *
 * ## Custom Copy Function
 * ```svelte
 * <script lang="ts">
 * 		import { UseClipboard } from "$lib/hooks/use-clipboard.svelte";
 *
 * 		// Use a custom copy function (e.g., for Tauri cross-platform support)
 * 		const clipboard = new UseClipboard({
 * 			copyFn: async (text) => {
 * 				await myCustomClipboardApi.writeText(text);
 * 			}
 * 		});
 * </script>
 * ```
 *
 */
export class UseClipboard {
	#copiedStatus = $state<'success' | 'failure'>();
	private delay: number;
	private copyFn: CopyFn;
	private timeout: ReturnType<typeof setTimeout> | undefined = undefined;

	constructor({ delay = 500, copyFn = defaultCopyFn }: Partial<Options> = {}) {
		this.delay = delay;
		this.copyFn = copyFn;
	}

	/** Copies the given text to the users clipboard.
	 *
	 * ## Usage
	 * ```ts
	 * clipboard.copy('Hello, World!');
	 * ```
	 *
	 * @param text
	 * @returns
	 */
	async copy(text: string) {
		if (this.timeout) {
			this.#copiedStatus = undefined;
			clearTimeout(this.timeout);
		}

		try {
			await this.copyFn(text);

			this.#copiedStatus = 'success';

			this.timeout = setTimeout(() => {
				this.#copiedStatus = undefined;
			}, this.delay);
		} catch {
			// an error can occur when not in the browser or if the user hasn't given clipboard access
			this.#copiedStatus = 'failure';

			this.timeout = setTimeout(() => {
				this.#copiedStatus = undefined;
			}, this.delay);
		}

		return this.#copiedStatus;
	}

	/** true when the user has just copied to the clipboard. */
	get copied() {
		return this.#copiedStatus === 'success';
	}

	/**	Indicates whether a copy has occurred
	 * and gives a status of either `success` or `failure`. */
	get status() {
		return this.#copiedStatus;
	}
}
