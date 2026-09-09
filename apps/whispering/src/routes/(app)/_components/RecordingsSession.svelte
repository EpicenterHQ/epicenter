<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingShell from './WhisperingShell.svelte';
	import { tick } from 'svelte';
	import { recordingActive } from '$lib/state/recording-active.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';

	// One keyed component owns one captured App. Its explicit close is awaited
	// by AppBoot before another session or any connection controls can appear.

	let { children, account }: { children: import('svelte').Snippet; account: Account | null } = $props();

	/* svelte-ignore state_referenced_locally */
	const app = account === null ? epicenter.openLocal() : epicenter.openAccount(account);
	let showing = $state(true);
	let shell: WhisperingShell | undefined = $state();
	let closing: Promise<void> | undefined;
	/** UI shutdown may save a final recording; drain the App afterwards. */
	export function close(): Promise<void> {
		if (closing) return closing;
		closing = (async () => {
			const ready = await app.ready;
			if (ready.error === null) {
				const recovered = await manualRecorder.recover(app.recording);
				if (recovered.error !== null) throw recovered.error;
				if (recordingActive.current) {
					throw new Error('Finish recording and wait for it to save before closing Whispering.');
				}
			}
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
	{#await app.ready}
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
				data={app}
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
