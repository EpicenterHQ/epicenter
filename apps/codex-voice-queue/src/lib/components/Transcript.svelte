<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Spinner } from '@epicenter/ui/spinner';
	import { tick } from 'svelte';
	import type { VoiceQueue } from '../queue.svelte.js';
	import TranscriptItem from './TranscriptItem.svelte';

	let { queue, active }: { queue: VoiceQueue; active: boolean } = $props();
	let viewport = $state<HTMLElement | null>(null);
	let displayedId: string | null = null;
	let positioned = false;

	$effect(() => {
		const id = queue.selectedId;
		const data = queue.transcript?.data;
		if (id !== displayedId || !data) {
			displayedId = id;
			positioned = false;
		}
		if (!active || !data || !viewport || positioned) return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || !viewport) return;
			viewport.scrollTop = viewport.scrollHeight;
			positioned = true;
		});
		return () => {
			cancelled = true;
		};
	});

	async function loadEarlier() {
		const id = queue.selectedId;
		const element = viewport;
		if (!id || !element) return;
		const height = element.scrollHeight;
		const top = element.scrollTop;
		await queue.loadTurns(id, true);
		await tick();
		if (queue.selectedId === id && viewport === element) {
			element.scrollTop = top + element.scrollHeight - height;
		}
	}
</script>

<ScrollArea bind:viewportRef={viewport} class="min-h-0 min-w-0 flex-1 overflow-hidden">
	<div class="mx-auto min-w-0 max-w-4xl space-y-6 break-words p-4 [overflow-wrap:anywhere] md:p-6">
		{#if queue.transcript?.error}
			<Alert.Root variant="destructive">
				<Alert.Title>Could not load conversation</Alert.Title>
				<Alert.Description>{queue.transcript.error}</Alert.Description>
				<Button
					variant="outline"
					onclick={() => queue.selectedId && queue.loadTurns(queue.selectedId)}
				>
					Retry
				</Button>
			</Alert.Root>
		{/if}
		{#if queue.transcript?.data?.nextCursor}
			<Button
				variant="outline"
				disabled={queue.transcript.loading}
				onclick={loadEarlier}
			>
				{#if queue.transcript.loading}
					<Spinner />
				{/if}
				Load earlier
			</Button>
		{/if}
		{#if queue.transcript?.loading && !queue.transcript.data}
			<Loading label="Loading conversation" />
		{/if}
		{#if queue.transcript?.data?.fallback}
			<p class="text-xs text-muted-foreground">Legacy history: showing the last 10 turns.</p>
		{/if}
		{#each queue.transcript?.data?.turns ?? [] as turn (turn.id)}
			<section
				class="divide-y divide-border border-b border-border pb-4"
				aria-label="Conversation turn"
			>
				<div class="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
					{#if turn.status !== 'completed'}
						<Badge variant={turn.status === 'failed' ? 'destructive' : 'outline'}>
							{turn.status}
						</Badge>
					{/if}
					{#if turn.durationMs !== null}
						<span>{(turn.durationMs / 1000).toFixed(1)}s</span>
					{/if}
					{#if turn.error}
						<span class="text-destructive">{turn.error.message}</span>
					{/if}
				</div>
				{#each turn.items as item, index (item.id ?? index)}
					<TranscriptItem {item} />
				{/each}
			</section>
		{/each}
		{#if queue.transcript?.data && queue.transcript.data.turns.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Title>No messages yet</Empty.Title>
					<Empty.Description>
						Record or type a message to continue this conversation.
					</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}
	</div>
</ScrollArea>
