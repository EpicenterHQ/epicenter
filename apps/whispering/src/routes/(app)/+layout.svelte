<!--
	Whispering's root (ADR-0894). In a browser only one tab runs it: a second
	tab says so and waits until the first closes (`holdOneTab`). The folder
	is read before the app renders, and read again whenever the window
	regains focus, since another program may write it (the folder query,
	`folder-query.ts`). Leaving asks first while typing is not yet saved.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createQuery, QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { holdShortcut, query } from '$lib/app.js';
	import { unsaved } from '$lib/note-editor.svelte.js';
	import { holdOneTab } from '$lib/one-tab.svelte.js';
	import { folderPath } from '$lib/this-computer.js';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();

	const tab = holdOneTab();
	const held = $derived(tab.state() === 'held');
	/** The folder, read once this tab holds it, and again whenever the window regains focus. */
	const read = createQuery(
		() => ({ ...query.folderQueries.read(), enabled: held }),
		() => query.queryClient,
	);
	/** Whether the folder was read once, so the app renders. A later read that fails leaves it shown. */
	const opened = $derived(read.data !== undefined);

	$effect(() => {
		// A browser may clear a site's storage; ask it to keep Whispering's.
		if (held) void navigator.storage?.persist?.().catch(() => false);
	});
	$effect(() => {
		if (opened) holdShortcut();
	});
</script>

<svelte:window
	onbeforeunload={(event) => {
		if (unsaved() > 0) event.preventDefault();
	}}
/>

{#if tab.state() === 'waiting'}
	<main class="flex h-dvh flex-col items-center justify-center gap-2 p-6 text-center" data-testid="other-tab">
		<p class="text-base font-medium">Whispering is open in another tab.</p>
		<p class="text-sm text-muted-foreground">Use that tab, or close it and this one opens.</p>
	</main>
{:else if !opened && read.error !== null}
	<main class="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center" role="alert" data-testid="folder-problem">
		<p class="text-base font-medium">Whispering could not read its folder.</p>
		<p class="max-w-md text-sm text-muted-foreground">{read.error.message}</p>
		<div class="flex gap-2">
			<Button size="sm" onclick={() => void read.refetch()}>Try again</Button>
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
	<QueryClientProvider client={query.queryClient}>
		<WhisperingApp>{@render children()}</WhisperingApp>
	</QueryClientProvider>
{/if}
