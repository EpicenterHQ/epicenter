<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './VocabShell.svelte';
	import { tick } from 'svelte';

	// One keyed component owns one captured App. Its explicit close is awaited
	// by AppBoot before another session or any connection controls can appear.

	let { account }: { account: Account } = $props();
	/* svelte-ignore state_referenced_locally */
	const app = epicenter.openAccount(account);
	let showing = $state(true);
	let shell: VocabShell | undefined = $state();
	let closing: Promise<void> | undefined;
	/** Stop dictation and chat before draining their final admitted writes. */
	export function close(): Promise<void> {
		closing ??= (async () => {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			const ui = shell?.close();
			showing = false;
			await tick();
			try {
				await ui;
			} finally {
				await app.close();
			}
		})();
		return closing;
	}
	$effect(() => () => void close().catch(() => {}));

	const removeLocalData = undefined;
</script>

{#if showing}
	{#await app.ready}
		<Loading class="h-dvh" label="Opening your conversations…" />
	{:then { error }}
		{#if error !== null}
			<CannotOpenScreen
				appName="Vocab"
				noun="conversations"
				{error}
				retry={() => location.reload()}
			/>
		{:else}
			<VocabShell {account} data={app} {removeLocalData} bind:this={shell} />
		{/if}
	{/await}
{:else}
	<Loading class="h-dvh" label="Closing your conversations…" />
{/if}
