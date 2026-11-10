<!-- Notes by creation time, with title search and a mark for a developed capture. -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import LinkIcon from '@lucide/svelte/icons/link';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { notes } from '$lib/notes.svelte.js';
	import { labelOf, matches, noteHref } from '$lib/notes.js';

	let { open }: { open?: string } = $props();
	let query = $state('');
	let adding = $state(false);
	const rows = $derived(notes.rows().filter((row) => matches(row, query)));

	async function add() {
		adding = true;
		try {
			const row = await notes.add();
			await goto(noteHref(row.path));
		} catch (error) {
			toast.error('Could not make the note', { description: String(error) });
		} finally {
			adding = false;
		}
	}
</script>

<header
	class="sticky top-0 z-10 border-b bg-background/95 px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-3 backdrop-blur"
>
	<div class="mb-3 flex items-center justify-between">
		<h1 class="text-2xl font-semibold tracking-tight">Notes</h1>
		<Button
			size="icon-lg"
			class="size-11"
			aria-label="New note"
			onclick={add}
			disabled={adding}
		>
			<PlusIcon />
		</Button>
	</div>
	<Input
		class="h-11"
		aria-label="Search notes by title"
		placeholder="Search titles"
		bind:value={query}
	/>
</header>
<div class="px-3 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
	{#if notes.problem()}
		<Alert.Root variant="destructive" class="mt-3">
			<Alert.Title>Epicenter did not answer</Alert.Title>
			<Alert.Description>
				<p>{notes.problem()}</p>
				<Button
					variant="outline"
					class="mt-2 min-h-11"
					onclick={() => notes.refresh()}
				>
					Try again
				</Button>
			</Alert.Description>
		</Alert.Root>
	{/if}
	{#if !notes.loaded()}
		<div class="flex justify-center py-16" role="status" aria-label="Loading notes">
			<Spinner class="size-5 text-muted-foreground" />
		</div>
	{:else}
		<ul class="mt-2">
			{#each rows as row (row.path)}
				<li>
					<a
						href={noteHref(row.path)}
						aria-current={row.path === open ? 'page' : undefined}
						class="my-1 flex min-h-16 flex-col gap-1 rounded-md px-3 py-3 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring {row.path === open
							? 'bg-accent'
							: ''}"
					>
						<span class="break-anywhere {row.title ? '' : 'text-muted-foreground'}">
							{labelOf(row)}
							{#if row.problems}
								<TriangleAlertIcon
									class="inline size-3.5"
									aria-label="Some of its file could not be read"
								/>
							{/if}
						</span>
						<span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							{#if row.createdAt && !Number.isNaN(Date.parse(row.createdAt))}
								<span>
									{new Date(row.createdAt).toLocaleDateString(undefined, { dateStyle: 'short' })}
								</span>
							{/if}
							{#if row.capture}
								<span><LinkIcon class="mr-1 inline size-3" />From Capture</span>
							{/if}
						</span>
					</a>
				</li>
			{:else}
				{#if !notes.problem()}
					<Empty.Root class="py-16">
						<Empty.Title>{query ? 'No matching notes' : 'No notes yet'}</Empty.Title>
						<Empty.Description>
							{query
								? 'Try another title.'
								: 'Make one, or ask your agent to develop a capture into one.'}
						</Empty.Description>
					</Empty.Root>
				{/if}
			{/each}
		</ul>
	{/if}
</div>
