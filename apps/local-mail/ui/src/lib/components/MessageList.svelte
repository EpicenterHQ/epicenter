<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { cn } from '@epicenter/ui/utils';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import StarIcon from '@lucide/svelte/icons/star';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import {
		chipLabelIds,
		decodeSnippet,
		labelDisplayName,
		senderName,
		shortDate,
	} from '$lib/format';
	import type { MailLabel, MessageSummary } from '$lib/types';

	let {
		messages,
		labels,
		selectedId,
		loading,
		error,
		mirrorEmpty,
		onSelect,
	}: {
		messages: MessageSummary[];
		labels: MailLabel[];
		selectedId: string | null;
		loading: boolean;
		error: string | null;
		mirrorEmpty: boolean;
		onSelect: (id: string) => void;
	} = $props();

	const nameOf = $derived(
		new Map(labels.map((l) => [l.id, labelDisplayName(l.id, l.name)])),
	);

	// Keep the keyboard-selected row visible: when the selection moves off the
	// visible slice (j/k paging past the fold), scroll it just into view.
	$effect(() => {
		if (!selectedId) return;
		document
			.querySelector(`[data-message-id="${selectedId}"]`)
			?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div class="flex min-w-0 flex-1 flex-col border-r border-border">
	{#if error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				<TriangleAlertIcon class="size-5 text-destructive" />
			</Empty.Media>
			<Empty.Title>Could not load messages</Empty.Title>
			<Empty.Description>{error}</Empty.Description>
		</Empty.Root>
	{:else if loading}
		<ul class="divide-y divide-border">
			{#each Array.from({ length: 8 }) as _, i (i)}
				<li class="space-y-2 px-3 py-2.5">
					<div class="flex justify-between gap-2">
						<Skeleton class="h-3 w-32" />
						<Skeleton class="h-3 w-10" />
					</div>
					<Skeleton class="h-3 w-full" />
				</li>
			{/each}
		</ul>
	{:else if messages.length === 0}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				{#if mirrorEmpty}
					<InboxIcon class="size-5" />
				{:else}
					<SearchXIcon class="size-5" />
				{/if}
			</Empty.Media>
			<Empty.Title>
				{mirrorEmpty ? 'No messages mirrored' : 'No messages match'}
			</Empty.Title>
			<Empty.Description>
				{mirrorEmpty
					? 'Run local-mail reconcile --full to populate the mirror.'
					: 'Try a different label or search term.'}
			</Empty.Description>
		</Empty.Root>
	{:else}
		<ul class="flex-1 min-h-0 divide-y divide-border overflow-y-auto">
			{#each messages as message (message.id)}
				{@const unread = message.labelIds.includes('UNREAD')}
				{@const starred = message.labelIds.includes('STARRED')}
				{@const chips = chipLabelIds(message.labelIds)}
				<li>
					<Item.Button
						size="sm"
						data-message-id={message.id}
						class={cn(
							'w-full items-start rounded-none text-left',
							selectedId === message.id
								? 'bg-accent'
								: 'hover:bg-accent/40',
						)}
						onclick={() => onSelect(message.id)}
					>
							<Item.Media class="mt-1.5">
							<span
								class={cn(
									'size-2 shrink-0 rounded-full',
									unread ? 'bg-sky-500' : 'bg-transparent',
								)}
								title={unread ? 'Unread' : 'Read'}
							></span>
						</Item.Media>
						<Item.Content class="min-w-0 gap-0">
							<span class="flex items-center gap-2">
								<span
									class={cn(
										'flex-1 truncate text-sm',
										unread
											? 'font-semibold text-foreground'
											: 'text-foreground/70',
									)}
								>
									{senderName(message.sender)}
								</span>
								{#if starred}
									<StarIcon
										class="size-3.5 shrink-0 fill-amber-400 text-amber-400"
									/>
								{/if}
								<span class="shrink-0 font-mono text-[0.7rem] text-muted-foreground tabular-nums">
									{shortDate(message.internalDate)}
								</span>
							</span>
							<span class="mt-0.5 block truncate text-sm">
								<span class={unread ? 'font-medium text-foreground' : 'text-foreground/80'}>
									{message.subject || '(no subject)'}
								</span>
								{#if message.snippet}
									<span class="text-muted-foreground">
										&nbsp;· {decodeSnippet(message.snippet)}
									</span>
								{/if}
							</span>
							{#if chips.length}
								<span class="mt-1 flex flex-wrap gap-1">
									{#each chips as id (id)}
										<Badge
											variant="outline"
											class="h-4 rounded px-1 text-[0.6rem] font-normal text-muted-foreground"
										>
											{nameOf.get(id) ?? labelDisplayName(id)}
										</Badge>
									{/each}
								</span>
							{/if}
						</Item.Content>
						</Item.Button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
