<!--
	Replies: every reply note in the Messages folder, read from this computer
	whether or not Beeper is reachable. A ready reply can be selected, and
	Send selected is the only thing on the page that sends: it names each
	selected reply with the version shown, and shows what happened to each.
	Connecting, reconnecting, and reloading never send.
-->
<script lang="ts">
	import type { InvalidReply, Reply, Send, SendResult } from '@epicenter/cli/messages-protocol';
	import NoteRepair from '@epicenter/svelte/note-repair';
	import { Button } from '@epicenter/ui/button';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Err, Ok } from 'wellcrafted/result';
	import type { Backend } from './backend.js';
	import BrowserDrafts from './BrowserDrafts.svelte';
	import { messages as contract } from './contract.js';
	import ReplyCard from './ReplyCard.svelte';
	import { sendable } from './replies.js';
	import SendStatus from './SendStatus.svelte';

	let {
		backend,
		profile,
		replies,
		invalid,
		unfiled,
		connectHint,
		onBack,
	}: {
		backend: Backend;
		profile: string | null;
		replies: Reply[];
		invalid: InvalidReply[];
		unfiled: Send[];
		connectHint: string;
		onBack: () => void;
	} = $props();
	const queryClient = useQueryClient();
	/** Selected replies, each by the version that was shown when it was selected. */
	let selected = $state<Record<string, string>>({});
	let results = $state<Record<string, SendResult>>({});
	let summary = $state('');
	const chosen = $derived(replies.filter((reply) => selected[reply.id] === reply.version && sendable(reply, profile)));
	const filed = $derived(new Set([...replies.map((reply) => reply.id), ...invalid.map((note) => note.id)]));
	const send = createMutation(() => ({
		mutationFn: async (items: { id: string; over: string }[]) => {
			const answer = await backend.request({ action: 'send', items });
			if (answer.kind !== 'sent') { summary = answer.kind === 'error' ? answer.message : 'Nothing was sent.'; return; }
			results = Object.fromEntries(answer.results.map((result) => [result.id, result]));
			selected = {};
			const accepted = answer.results.filter((result) => result.outcome === 'accepted').length;
			const rest = answer.results.length - accepted;
			summary = `${accepted} sent ${backend.kind === 'demo' ? 'in the demo' : 'to Beeper'}${rest ? `, ${rest} not sent: see each reply` : ''}.`;
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
			await queryClient.invalidateQueries({ queryKey: ['beeper'] });
		},
		onError: () => { summary = 'Messages did not answer. Check Beeper before sending again.'; },
	}));
	function toggle(reply: Reply, on: boolean) {
		if (on) selected[reply.id] = reply.version;
		else delete selected[reply.id];
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Replies">
	<header class="flex flex-wrap items-center gap-3 border-b p-4">
		<Button variant="ghost" size="sm" class="md:hidden" onclick={onBack}>Back</Button>
		<h2 class="font-semibold">Replies</h2>
		<span class="text-xs text-muted-foreground">{backend.kind === 'demo' ? 'Kept in this demo until reload' : 'Kept as Markdown in your Messages folder'}</span>
		<div class="ml-auto flex items-center gap-2">
			{#if profile === null}<span class="text-xs text-muted-foreground">{connectHint}</span>{/if}
			<Button disabled={profile === null || chosen.length === 0 || send.isPending} onclick={() => send.mutate(chosen.map(({ id, version }) => ({ id, over: version })))}>{send.isPending ? 'Sending…' : `Send selected${chosen.length ? ` (${chosen.length})` : ''}`}</Button>
		</div>
	</header>
	{#if summary}<p role="status" class="border-b p-3 text-sm">{summary}</p>{/if}
	<div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
		{#if replies.length === 0 && unfiled.length === 0 && invalid.length === 0}
			<p class="text-sm text-muted-foreground">{#if backend.kind === 'demo'}No replies yet. Write one in a fictional conversation.{:else}No replies yet. Write one in a conversation, or add a note to the folder's <code>replies/</code>.{/if}</p>
		{/if}
		{#each replies as reply (reply.id)}
			<ReplyCard {backend} {reply} {profile} selectable allowAnother selected={selected[reply.id] === reply.version} result={results[reply.id]} onselect={(on: boolean) => toggle(reply, on)} />
		{/each}
		{#if unfiled.length > 0}
			<section class="space-y-2" aria-label="Sends without reply files">
				<h3 class="text-sm font-semibold">Sends without reply files</h3>
				<p class="text-xs text-muted-foreground">The reply files are missing. The send journal keeps their text here until they are settled or the drafts can be restored.</p>
				{#each unfiled as sent (sent.attemptId)}
					<article class="space-y-1 rounded-lg border p-3" aria-label={`Send to ${sent.chatTitle || sent.chatId}`}>
						<p class="text-sm font-medium">{sent.chatTitle || sent.chatId}</p>
						<SendStatus {backend} send={sent} showText />
					</article>
				{/each}
			</section>
		{/if}
		{#each invalid as note (note.path)}
			<section class="space-y-2" aria-label="Reply to repair">
				<p role="alert" class="text-sm text-destructive">{note.path} does not read as a reply. Fix it here or in any editor.</p>
				<NoteRepair {contract} {note} replace={async (text, { over }) => {
					const answer = await backend.request({ action: 'repair', id: note.id, over, text });
					await queryClient.invalidateQueries({ queryKey: ['staging'] });
					return answer.kind === 'saved' ? Ok(answer.reply) : Err({ message: answer.kind === 'error' ? answer.message : 'Not saved.' });
				}} />
			</section>
		{/each}
		{#if backend.kind === 'local'}<BrowserDrafts {backend} {filed} />{/if}
	</div>
</section>
