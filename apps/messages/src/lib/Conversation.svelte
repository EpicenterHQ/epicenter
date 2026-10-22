<script lang="ts">
	import type { Conversation, Message } from '@epicenter/cli/messages-protocol';
	import { getFolder } from './folder.js';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { createInfiniteQuery, createMutation, createQuery } from '@tanstack/svelte-query';
	import { tick } from 'svelte';
	import type { Backend } from './backend.js';
	import { draftId } from './drafts.js';
	import Composer from './Composer.svelte';
	import DemoAttachment from './DemoAttachment.svelte';
	import { demoAttachments } from './demo/attachments.js';
	let { backend, chat, onBack }: { backend: Backend; chat: Conversation; onBack: () => void } = $props();
	const { queryClient } = getFolder();
	let scroller: HTMLDivElement;
	let follow = $state(true);
	const messages = createInfiniteQuery(() => ({
		queryKey: ['beeper', backend.mode, backend.profile, 'messages', chat.id],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const answer = await backend.request({ action: 'messages', chatId: chat.id, cursor: pageParam });
			if (answer.kind !== 'messages') throw new Error(answer.kind === 'error' ? answer.message : 'Could not read messages.');
			return answer.page;
		},
		getNextPageParam: (page) => page.cursor ?? undefined,
		refetchInterval: 4000,
		staleTime: 0,
	}));
	const draft = createQuery(() => ({
		queryKey: ['draft', backend.mode, backend.profile, chat.id],
		queryFn: async () => ({ id: await draftId(backend, chat.id) }),
	}));
	const items = $derived([...new Map((messages.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)));
	const openBeeper = createMutation(() => ({ mutationFn: () => backend.request({ action: 'focus', chatId: chat.id }) }));
	$effect(() => {
		items.length;
		if (follow) void tick().then(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight; });
	});
	function status(message: Message) {
		if (!message.mine || !message.status) return '';
		return ({ SUCCESS: 'Sent', PENDING: 'Sending', FAIL_RETRIABLE: 'Send failed: check Beeper', FAIL_PERMANENT: 'Send failed: check Beeper' } as Record<string, string>)[message.status] ?? 'Check status in Beeper';
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Conversation">
	<header class="flex items-center gap-3 border-b p-4">
		<Button variant="ghost" size="sm" class="md:hidden" onclick={onBack}>Back</Button>
		<div class="min-w-0 flex-1"><h2 class="truncate font-semibold">{chat.title}</h2><p class="text-xs text-muted-foreground">{chat.network}</p></div>
		{#if backend.mode === 'live'}<Button variant="outline" size="sm" disabled={openBeeper.isPending} onclick={() => openBeeper.mutate()}>Open in Beeper</Button>{/if}
	</header>
	{#if openBeeper.data?.kind === 'error'}<p role="alert" class="p-3 text-sm text-destructive">{openBeeper.data.message}</p>{/if}
	{#if openBeeper.error}<p role="alert" class="p-3 text-sm text-destructive">Could not open Beeper.</p>{/if}
	<div class="min-h-0 flex-1 overflow-y-auto p-4" bind:this={scroller} onscroll={() => { follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; }}>
		{#if messages.isPending}<Loading label="Loading messages…" />{/if}
		{#if messages.error}<p role="alert" class="mb-3 text-sm text-destructive">{messages.error.message}</p><Button variant="outline" size="sm" onclick={() => void messages.refetch()}>Try again</Button>{/if}
		{#if messages.hasNextPage}<Button variant="outline" size="sm" disabled={messages.isFetchingNextPage} onclick={() => { follow = false; void messages.fetchNextPage(); }}>Load older messages</Button>{/if}
		{#if !messages.isPending && !messages.error && items.length === 0}<p class="text-sm text-muted-foreground">No messages available in Beeper yet.</p>{/if}
		<ol class="space-y-4" aria-label="Messages">
			{#each items as message (message.id)}
				{@const demoAttachment = backend.mode === 'demo' ? demoAttachments[message.id] : undefined}
				<li class="flex" class:justify-end={message.mine}>
					<div class="max-w-[85%] space-y-1 rounded-lg bg-muted px-3 py-2" class:bg-primary={message.mine} class:text-primary-foreground={message.mine}>
						<p class="text-xs opacity-75">{message.mine ? 'You' : message.sender}</p>
						{#if message.text}<p class="whitespace-pre-wrap break-words text-sm">{message.text}</p>
						{:else if !demoAttachment && !message.attachment}<p class="text-sm">Unsupported message</p>{/if}
						{#if demoAttachment}<DemoAttachment attachment={demoAttachment} />
						{:else if message.attachment}<p class="text-xs">Attachment · open in Beeper to view</p>{/if}
						<p class="text-xs opacity-75"><time datetime={message.timestamp}>{new Date(message.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> {status(message)}</p>
					</div>
				</li>
			{/each}
		</ol>
	</div>
	{#if draft.error}<p role="alert" class="border-t p-4 text-sm text-destructive">Could not open your draft: {draft.error.message}</p>
	{:else if draft.data}
		{#key draft.data.id}<Composer {backend} id={draft.data.id} chatId={chat.id} onAccepted={() => { follow = true; void messages.refetch(); void queryClient.invalidateQueries({ queryKey: ['beeper', backend.mode, backend.profile, 'chats'] }); }} />{/key}
	{/if}
</section>
