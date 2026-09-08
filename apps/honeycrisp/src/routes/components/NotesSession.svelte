<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import StoreShell from './StoreShell.svelte';
	import { tick } from 'svelte';

	// One keyed component owns one captured App. Its explicit close is awaited
	// by AppBoot before another session or any connection controls can appear.

	let { account }: { account: Account } = $props();
	/* svelte-ignore state_referenced_locally */
	const app = epicenter.openAccount(account);
	let showing = $state(true);
	let closing: Promise<void> | undefined;
	/** Quiesce the editor before waiting for the App's admitted writes. */
	export function close(): Promise<void> {
		closing ??= (async () => {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			showing = false;
			await tick();
			await app.close();
		})();
		return closing;
	}
	$effect(() => () => void close().catch(() => {}));

	const removeLocalData = undefined;
</script>

{#if showing}
	{#await app.ready}
		<Loading class="h-dvh" label="Opening your notes…" />
	{:then { error }}
		{#if error !== null}
			<CannotOpenScreen
				appName="Honeycrisp"
				noun="notes"
				{error}
				retry={() => location.reload()}
			/>
		{:else}
			<StoreShell data={app} {removeLocalData} />
		{/if}
	{/await}
{:else}
	<Loading class="h-dvh" label="Closing your notes…" />
{/if}
