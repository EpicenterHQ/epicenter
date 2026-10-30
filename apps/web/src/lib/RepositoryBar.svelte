<!--
	The bar above every app: the repository it shows (its page is one click
	away), and where its files stand. A repository kept only on this device
	says so; one that syncs counts the files not yet sent (sending, or
	waiting) and those refused here with a reason only a person can fix, across every file, whichever app wrote it. Where
	this browser holds work that exists nowhere else and its storage is not
	persistent, the bar says the browser may delete it (`storageLine`).
-->
<script lang="ts">
	import type { FileEntry } from '@epicenter/repository';
	import { type Persistence, storagePersistence } from '@epicenter/repository/browser';
	import { storageLine, syncLine } from '@epicenter/svelte/status-line';
	import { addressOf, type Manifest, whereOf } from './device.svelte.js';
	import type { ShellRepository } from './lens.js';

	let { repo, manifest, app }: { repo: ShellRepository; manifest: Manifest; app: string } = $props();

	/** The files not yet synced, as of the last change: as many as wait, never the whole repository. */
	let waiting = $state.raw<readonly FileEntry[]>([]);
	$effect(() => {
		if (manifest.url === null) return;
		repo.revision();
		void repo.files.waiting().then(({ data }) => {
			if (data !== null) waiting = data;
		});
	});

	const line = $derived.by(() => {
		if (manifest.url === null) return { label: 'On this device', tone: 'neutral' as const, detail: undefined };
		let sending = 0;
		let refused = 0;
		for (const { state } of waiting) {
			if (state.status === 'refused') refused++;
			else if (state.status !== 'synced') sending++;
		}
		return syncLine({ sending, refused });
	});
	const address = $derived(addressOf(manifest));

	/** Whether this browser's storage is persistent; the first save asks for it. */
	let persistence = $state<Persistence>('checking');
	$effect(() => storagePersistence.subscribe((next) => (persistence = next)));
	const storage = $derived(storageLine({ persistence, local: manifest.url === null, unsent: waiting.length > 0 }));
</script>

<nav class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-xs" aria-label="Repository">
	<a class="font-medium hover:underline" href={address} aria-label="{manifest.name}: this repository's page">{manifest.name}</a>
	<code class="truncate text-muted-foreground">{address}</code>
	<span class="text-muted-foreground">·</span>
	<span class="truncate text-muted-foreground">{app}</span>
	<span class="ml-auto flex min-w-0 items-center gap-1.5" data-testid="repository-sync" data-tone={line.tone} title={line.detail ?? whereOf(manifest)}>
		<span
			class={[
				'size-2 shrink-0 rounded-full',
				line.tone === 'good' && 'bg-emerald-500',
				line.tone === 'busy' && 'bg-sky-500',
				line.tone === 'warning' && 'bg-amber-500',
				line.tone === 'error' && 'bg-destructive',
				line.tone === 'neutral' && 'bg-muted-foreground/50',
			]}
		></span>
		<span class="truncate">{line.label}</span>
	</span>
</nav>
{#if storage !== null}
	<p class="shrink-0 border-b bg-amber-50 px-3 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="status" data-testid="repository-storage">{storage.label}</p>
{/if}
