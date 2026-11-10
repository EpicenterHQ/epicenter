<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import StarIcon from '@lucide/svelte/icons/star';
	import { showChip } from '$lib/format.js';
	import type { Message } from '$lib/mail.svelte.js';

	let { message }: { message: Message } = $props();
</script>

<li class="border-b last:border-0">
	<a
		href="#/messages/{message.id}"
		class="block space-y-1 px-4 py-3 hover:bg-muted/50
			focus-visible:outline-ring focus-visible:outline-2"
	>
		<div class="flex items-center gap-2">
			<span class="min-w-0 flex-1 truncate" class:font-semibold={message.unread}>
				{message.from.name}
			</span>
			{#if message.starred}
				<StarIcon class="size-4 shrink-0 fill-current" aria-label="Starred" />
			{/if}
			<time class="shrink-0 text-xs text-muted-foreground" datetime={message.date}>
				{new Date(message.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
			</time>
		</div>
		<p class="truncate text-sm" class:font-semibold={message.unread}>{message.subject}</p>
		<p class="truncate text-sm text-muted-foreground">{message.snippet}</p>
		<div class="flex flex-wrap gap-1">
			{#each message.labels.filter((label) => showChip(label.id)) as label (label.id)}
				<Badge variant="secondary">{label.name}</Badge>
			{/each}
			{#if message.pending.length}
				<Badge variant="outline">Waiting to send</Badge>
			{/if}
		</div>
	</a>
</li>
