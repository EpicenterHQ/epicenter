<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { mailbox } from '$lib/mail.svelte.js';
	import MessageRow from './MessageRow.svelte';

	let draft = $state('');
	const result = $derived(mailbox.result());
	const view = $derived(mailbox.views().find((view) => view.path === mailbox.path()));

	$effect(() => {
		draft = mailbox.query();
	});

	function search(event: SubmitEvent) {
		event.preventDefault();
		void mailbox.search(draft);
	}
</script>

<section aria-label="Mail search">
	<div class="space-y-3 border-b p-4">
		{#if view}
			<h2 class="font-semibold">{view.title ?? view.name}</h2>
			<p class="text-sm text-muted-foreground">Saved search: {view.query}</p>
		{/if}
		<form class="flex gap-2" onsubmit={search}>
			<Input
				aria-label={view ? 'Refine saved search' : 'Search mail'}
				placeholder={view ? 'Refine this search' : 'Search mail'}
				bind:value={draft}
			/>
			<Button type="submit" disabled={mailbox.busy()}>Search</Button>
		</form>
		{#if result}
			<p class="text-sm text-muted-foreground" aria-live="polite">
				{result.total} {result.total === 1 ? 'message' : 'messages'}{result.total >
				result.messages.length
					? `, showing ${result.messages.length}`
					: ''}
			</p>
		{/if}
	</div>
	{#if result?.refreshedAt === null}
		<Empty.Root class="py-16">
			<Empty.Header>
				<Empty.Title>Nothing loaded yet</Empty.Title>
				<Empty.Description>Load the demo mailbox to read and search mail.</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button disabled={mailbox.busy()} onclick={() => mailbox.refresh()}>Refresh</Button>
			</Empty.Content>
		</Empty.Root>
	{:else if result && result.messages.length === 0}
		<Empty.Root class="py-16">
			<Empty.Header>
				<Empty.Title>No messages found</Empty.Title>
				<Empty.Description>Try another search.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if result}
		<ul>
			{#each result.messages as message (message.id)}
				<MessageRow {message} />
			{/each}
		</ul>
	{/if}
</section>
