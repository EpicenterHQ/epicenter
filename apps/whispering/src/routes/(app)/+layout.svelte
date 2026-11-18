<!--
	Whispering's root (ADR-0894). In a browser only one tab runs it: a second
	tab says so and waits until the first closes (`holdOneTab`). The folder
	is read before the app renders, and read again whenever the window
	regains focus, since another program may write it. Leaving asks first
	while typing is not yet saved.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { Snippet } from 'svelte';
	import { folder, holdShortcut } from '$lib/app.js';
	import { unsaved } from '$lib/notes.svelte.js';
	import { holdOneTab } from '$lib/one-tab.svelte.js';
	import { folderPath } from '$lib/this-computer.js';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();

	const tab = holdOneTab();
	let started = false;
	/** Whether the folder was read once, so the app renders. A later read that fails leaves it shown. */
	let opened = $state(false);

	/** Read the folder for the first time. */
	async function open() {
		// A browser may clear a site's storage; ask it to keep Whispering's.
		void navigator.storage?.persist?.().catch(() => false);
		const { error } = await folder.load();
		if (error !== null) return;
		opened = true;
		holdShortcut();
	}

	$effect(() => {
		if (tab.state() !== 'held' || started) return;
		started = true;
		void open();
	});

	/** Read the folder again, as another program may have written it. */
	function reload() {
		if (opened) void folder.load();
	}
</script>

<svelte:window
	onfocus={reload}
	onbeforeunload={(event) => {
		if (unsaved() > 0) event.preventDefault();
	}}
/>

{#if tab.state() === 'waiting'}
	<main class="flex h-dvh flex-col items-center justify-center gap-2 p-6 text-center" data-testid="other-tab">
		<p class="text-base font-medium">Whispering is open in another tab.</p>
		<p class="text-sm text-muted-foreground">Use that tab, or close it and this one opens.</p>
	</main>
{:else if !opened && folder.loadProblem() !== null}
	<main class="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="folder-problem">
		<p class="text-base font-medium">Whispering could not read its folder.</p>
		<p class="max-w-md text-sm text-muted-foreground">{folder.loadProblem()?.message}</p>
		<div class="flex gap-2">
			<Button size="sm" onclick={() => void open()}>Try again</Button>
			{#if folderPath.get() !== null}
				<!-- A folder the person picked may be gone, or no longer granted. -->
				<Button
					size="sm"
					variant="outline"
					onclick={() => {
						folderPath.set(null);
						location.reload();
					}}>Use the default folder</Button
				>
			{/if}
		</div>
	</main>
{:else if !opened}
	<main class="flex h-dvh items-center justify-center" role="status" aria-label="Opening Whispering">
		<Spinner class="size-5" />
	</main>
{:else}
	<WhisperingApp>{@render children()}</WhisperingApp>
{/if}
