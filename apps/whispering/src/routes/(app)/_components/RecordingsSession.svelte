<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingShell from './WhisperingShell.svelte';
	import { tick } from 'svelte';

	// One keyed component owns one captured App. Its explicit close is awaited
	// by AppBoot before another session or any connection controls can appear.

	let { children, account }: { children: import('svelte').Snippet; account: Account | null } = $props();

	/* svelte-ignore state_referenced_locally */
	const openedApp = account === null ? epicenter.openLocal() : epicenter.openAccount(account);
	let showing = $state(true);
	let shell: WhisperingShell | undefined = $state();
	let closing: Promise<void> | undefined;
	/** UI shutdown may save a final recording; drain the App afterwards. */
	export function close(): Promise<void> {
		if (closing) return closing;
		closing = (async () => {
			const ready = await openedApp.ready;
			if (ready.error === null) {
				if (shell) await shell.recoverRecording();
				else {
					const recovered = await openedApp.recording.current();
					if (recovered.error) throw recovered.error;
					if (recovered.data) throw new Error('Finish recording before closing Whispering.');
				}
			}
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			const ui = shell?.close();
			showing = false;
			try {
				await tick();
				await ui;
			} finally {
				await openedApp.close();
			}
		})();
		void closing.catch(() => {
			// Recovery/capture refusal happens before teardown and may be retried.
			if (showing) closing = undefined;
		});
		return closing;
	}
	$effect(() => () => void close().catch(() => {}));

	// Whole-library erasure remains unavailable until one App owns its full scope.
	const removeLocalData = undefined;
</script>

{#if showing}
	{#await openedApp.ready}
		<Loading class="h-dvh" label="Opening your recordings…" />
	{:then { error }}
		{#if error !== null}
			<CannotOpenScreen
				appName="Whispering"
				noun="recordings"
				{error}
				retry={() => location.reload()}
			/>
		{:else}
			<WhisperingShell
				{account}
				{openedApp}
				{removeLocalData}
				bind:this={shell}
			>
				{@render children()}
			</WhisperingShell>
		{/if}
	{/await}
{:else}
	<Loading class="h-dvh" label="Closing your recordings…" />
{/if}
