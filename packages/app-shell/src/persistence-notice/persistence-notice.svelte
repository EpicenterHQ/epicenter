<script lang="ts">
	import type { PersistenceCapability } from '@epicenter/data';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	/**
	 * What a person is told when their edits are not reaching this device.
	 *
	 * Accepting an edit and storing it are two steps (ADR-0238), and the second
	 * one can fail: a full disk, an evicted origin, a private window that refuses
	 * to write. The live document keeps every edit either way, so nothing is lost
	 * while the tab is open, and everything is lost when it closes. That gap used
	 * to be paid in silence.
	 *
	 * **Only `blocked` earns words.** `pending` is the microtask between accepting
	 * an edit and confirming it, so rendering it would flicker on every keystroke
	 * and say nothing; `saved` is this component rendering nothing at all.
	 *
	 * Mount it inside the shell, where the opened store already is. It must not
	 * live in the account popover, which is closed until somebody clicks it, and
	 * "always visible" is the whole point.
	 */
	let { persistence }: { persistence: PersistenceCapability } = $props();

	// No poll and no effect: `fromData` makes this read reactive through the
	// store's own subscription, which fires only when the status changes.
	const blocked = $derived(persistence.get() === 'blocked');

	let retrying = $state(false);

	async function retry() {
		retrying = true;
		try {
			// The only retry the controller has, apart from the next edit. It
			// settles whatever the outcome, and the outcome is the status this
			// component is already rendering, so there is nothing to report here:
			// the notice stays or it goes.
			await persistence.flush();
		} finally {
			retrying = false;
		}
	}
</script>

{#if blocked}
	<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
		<TriangleAlert class="size-4" />
		<Alert.Title>Changes are not being saved on this device</Alert.Title>
		<Alert.Description class="flex items-center justify-between gap-3">
			<span>If you close this window, recent edits will be lost.</span>
			<Button size="sm" variant="outline" onclick={retry} disabled={retrying}>
				Try again
			</Button>
		</Alert.Description>
	</Alert.Root>
{/if}
