<!--
	One reply note: its conversation, whether it is a draft or ready, its
	text, and its latest send. Editing saves over the version shown, so a
	note an agent or editor changed meanwhile is refused and the typed text
	stays. Marking it ready sends nothing; a ready reply is sent only when
	selected in Replies and Send selected is pressed.
-->
<script lang="ts">
	import type { Reply, SendResult } from '@epicenter/cli/messages-protocol';
	import { holdLeave } from '@epicenter/svelte/leave-guard';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';
	import type { Backend } from './backend.js';
	import { chatName, sendable } from './replies.js';
	import Composer from './Composer.svelte';
	import SendStatus from './SendStatus.svelte';

	let {
		backend,
		reply,
		profile,
		selectable = false,
		allowAnother = false,
		selected = false,
		onselect,
		result,
	}: {
		backend: Backend;
		reply: Reply;
		profile: string | null;
		/** Offer a checkbox that selects this reply to send. */
		selectable?: boolean;
		/** Allow a new draft for this known conversation, even without Beeper. */
		allowAnother?: boolean;
		selected?: boolean;
		onselect?: (selected: boolean) => void;
		/** What the last Send selected did with this reply. */
		result?: SendResult;
	} = $props();
	const queryClient = useQueryClient();
	/** The text being edited, or null when the note is only shown. */
	let editing = $state<string | null>(null);
	/** The version the editing began from, which a save goes over. */
	// svelte-ignore state_referenced_locally
	let base = $state(reply.version);
	let message = $state('');
	let composing = $state(false);
	const canSend = $derived(sendable(reply, profile));
	const otherAccounts = $derived(profile !== null && reply.profile !== profile);
	const save = createMutation(() => ({
		mutationFn: async ({ status, body, over }: { status: 'draft' | 'ready'; body: string; over: string }) => {
			const answer = await holdLeave(backend.request({ action: 'save', id: reply.id, over, chatId: reply.chatId, profile: reply.profile, status, body }));
			if (answer.kind !== 'saved') { message = answer.kind === 'error' ? answer.message : 'Not saved.'; return; }
			editing = null; message = '';
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
		},
		onError: () => { message = 'Not saved. The text is still here.'; },
	}));
	const remove = createMutation(() => ({
		mutationFn: async () => {
			const answer = await holdLeave(backend.request({ action: 'remove', id: reply.id, over: reply.version }));
			if (answer.kind !== 'removed') { message = answer.kind === 'error' ? answer.message : 'Not deleted.'; return; }
			await queryClient.invalidateQueries({ queryKey: ['staging'] });
		},
		onError: () => { message = 'Not deleted.'; },
	}));
	const busy = $derived(save.isPending || remove.isPending);
	function resultText(result: SendResult) {
		return result.outcome === 'accepted'
			? backend.kind === 'demo' ? 'Sent in the demo.' : 'Sent to Beeper.'
			: result.message;
	}
</script>

<svelte:window onbeforeunload={(event) => { if (editing !== null && editing !== reply.body) event.preventDefault(); }} />

<article class="space-y-2 rounded-lg border p-3" aria-label={`Reply to ${chatName(reply)}`}>
	<header class="flex flex-wrap items-center gap-2">
		{#if selectable}
			<input type="checkbox" class="size-4" aria-label={`Select reply to ${chatName(reply)}`} disabled={!canSend} checked={selected && canSend} onchange={(event) => onselect?.(event.currentTarget.checked)} />
		{/if}
		<span class="truncate text-sm font-medium">{chatName(reply)}</span>
		<Badge variant={reply.status === 'ready' ? 'default' : 'secondary'}>{reply.status === 'ready' ? 'Ready' : 'Draft'}</Badge>
		{#if otherAccounts}<Badge variant="outline">For other Beeper accounts</Badge>{/if}
	</header>
	{#if editing === null}
		<p class="whitespace-pre-wrap break-words text-sm">{reply.body || 'Empty draft'}</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" size="sm" disabled={busy} onclick={() => { editing = reply.body; base = reply.version; message = ''; }}>Edit</Button>
			{#if reply.status === 'draft'}
				<Button variant="outline" size="sm" disabled={busy || !reply.body.trim()} onclick={() => save.mutate({ status: 'ready', body: reply.body, over: reply.version })}>Mark ready</Button>
			{:else}
				<Button variant="outline" size="sm" disabled={busy} onclick={() => save.mutate({ status: 'draft', body: reply.body, over: reply.version })}>Back to draft</Button>
			{/if}
			<CopyButton text={reply.body} size="sm" variant="ghost">Copy</CopyButton>
			<Button variant="ghost" size="sm" disabled={busy} onclick={() => remove.mutate()}>Delete</Button>
			{#if allowAnother}<Button variant="outline" size="sm" onclick={() => { composing = !composing; }}>New reply to this conversation</Button>{/if}
		</div>
	{:else}
		<label for={`edit-${reply.id}`} class="sr-only">Reply text</label>
		<Textarea id={`edit-${reply.id}`} rows={3} maxlength={20000} bind:value={editing} />
		<div class="flex flex-wrap gap-2">
			<Button size="sm" disabled={busy} onclick={() => save.mutate({ status: reply.status, body: editing ?? '', over: base })}>Save</Button>
			<Button variant="outline" size="sm" disabled={busy} onclick={() => { editing = reply.body; base = reply.version; message = ''; }}>Load the folder's text</Button>
			<Button variant="ghost" size="sm" disabled={busy} onclick={() => { editing = null; message = ''; }}>Cancel</Button>
		</div>
	{/if}
	{#if reply.send}<SendStatus {backend} send={reply.send} />{/if}
	{#if composing}<Composer {backend} chat={{ id: reply.chatId, title: chatName(reply) }} profile={reply.profile} inputId={`reply-${reply.id}`} onSaved={() => { composing = false; }} />{/if}
	{#if result}<p role="status" class="text-sm" class:text-destructive={result.outcome !== 'accepted'}>{resultText(result)}</p>{/if}
	{#if message}<p role="alert" class="text-sm text-destructive">{message}</p>{/if}
</article>
