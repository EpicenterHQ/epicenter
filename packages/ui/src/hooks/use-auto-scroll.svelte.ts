/*
	Installed from @ieedan/shadcn-svelte-extras
*/

/** Use this on a vertically scrollable container to ensure that it automatically scrolls to the bottom of the content.
 *
 * ## Usage
 * ```svelte
 * <script lang="ts">
 *      import { UseAutoScroll } from '$lib/hooks/use-auto-scroll.svelte';
 *
 *      let { children } = $props();
 *
 *      const autoScroll = new UseAutoScroll();
 * </script>
 *
 * <div>
 *      <div bind:this={autoScroll.ref}>
 *          {@render children?.()}
 *      </div>
 *      {#if !autoScroll.isAtBottom}
 *          <button onclick={() => autoScroll.scrollToBottom()}>
 *              Scroll To Bottom
 *          </button>
 *      {/if}
 * </div>
 * ```
 */
export class UseAutoScroll {
	/** Checks if the container is scrolled to the bottom */
	get isAtBottom() {
		if (!this.#ref) return true;

		return this.#scrollY + this.#ref.offsetHeight >= this.#ref.scrollHeight;
	}
	// bind:this clears the reference on unmount; rebinding releases the old element too.
	set ref(ref: HTMLElement | null | undefined) {
		if (ref === this.#ref) return;
		this.#cleanup?.();
		this.#cleanup = undefined;
		this.#ref = ref;

		if (!ref) return;

		let lastScrollHeight = ref.scrollHeight;

		// start from bottom or start position
		ref.scrollTo({
			top: this.#scrollY ? this.#scrollY : ref.scrollHeight,
			behavior: 'instant',
		});

		const onScroll = () => {
			this.#scrollY = ref.scrollTop;
			this.disableAutoScroll();
		};
		ref.addEventListener('scroll', onScroll);
		onScroll();

		const onResize = () => {
			this.scrollToBottom(true);
		};
		window.addEventListener('resize', onResize);

		// Follow appended messages and streaming text only while pinned to the bottom.
		const observer = new MutationObserver(() => {
			if (ref.scrollHeight !== lastScrollHeight) {
				this.scrollToBottom(true);
			}

			lastScrollHeight = ref.scrollHeight;
		});

		observer.observe(ref, {
			childList: true,
			characterData: true,
			subtree: true,
		});
		this.#cleanup = () => {
			ref.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			observer.disconnect();
		};
	}
	get ref() {
		return this.#ref;
	}
	get scrollY() {
		return this.#scrollY;
	}

	#ref = $state<HTMLElement | null>();
	#cleanup: (() => void) | undefined;

	#scrollY: number = $state(0);

	#userHasScrolled = $state(false);

	/** Disables auto scrolling until the container is scrolled back to the bottom */
	disableAutoScroll() {
		if (this.isAtBottom) {
			this.#userHasScrolled = false;
		} else {
			this.#userHasScrolled = true;
		}
	}

	/** Scrolls the container to the bottom */
	scrollToBottom(auto = false) {
		if (!this.#ref) return;

		// don't auto scroll if user has scrolled
		if (auto && this.#userHasScrolled) return;

		this.#ref.scrollTo({
			top: this.#ref.scrollHeight,
			// Intermediate smooth-scroll events otherwise look like reading history.
			behavior: 'instant',
		});
		this.#scrollY = this.#ref.scrollTop;
		this.disableAutoScroll();
	}
}
