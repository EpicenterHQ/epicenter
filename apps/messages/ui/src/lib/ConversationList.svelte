<script lang="ts">
	import { page } from '$app/state';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import { list, watch } from './messages.svelte.js';

	$effect(() => watch(list.refresh, 10_000));
</script>

<header class="border-b p-5">
	<h1 class="text-xl font-semibold">Messages</h1>
	<p class="text-sm text-muted-foreground">Fictional Beeper conversations</p>
</header>

{#if list.problem()}
	<div role="alert" class="space-y-2 p-4 text-sm">
		<p>{list.problem()}</p>
		<Button variant="outline" onclick={list.refresh}>Try again</Button>
	</div>
{/if}

{#if !list.rows()}
	<div class="p-8" role="status" aria-label="Loading conversations">
		<Spinner />
	</div>
{:else}
	<nav aria-label="Conversations">
		{#each list.rows() ?? [] as row (row.chat)}
			<a
				href="#/{row.chat}"
				aria-current={page.params.chat === row.chat ? 'page' : undefined}
				class="block border-b p-5 hover:bg-muted focus-visible:bg-muted {page.params.chat === row.chat ? 'bg-muted' : ''}"
			>
				<div class="flex items-baseline justify-between gap-2">
					<span class="font-medium">{row.title}</span>
					<time class="text-xs text-muted-foreground" datetime={row.activity}>
						{new Date(row.activity).toLocaleDateString(undefined, {
							month: 'short',
							day: 'numeric',
						})}
					</time>
				</div>
				<div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
					{row.network}
					{#if row.send?.needsCheck}
						<Badge variant="outline">Check send</Badge>
					{/if}
				</div>
				<p class="mt-2 truncate text-sm {row.draft ? 'text-foreground' : 'text-muted-foreground'}">
					{row.draft ? `Draft: ${row.draft}` : row.preview}
				</p>
			</a>
		{:else}
			<Empty.Root>
				<Empty.Title>No conversations</Empty.Title>
			</Empty.Root>
		{/each}
	</nav>
{/if}
