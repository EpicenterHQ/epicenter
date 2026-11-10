<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Select from '@epicenter/ui/select';
	import { mailbox, type MessageFile } from '$lib/mail.svelte.js';

	let { message }: { message: MessageFile } = $props();
	let selected = $state('');
	const userLabels = $derived(mailbox.labels().filter((label) => label.type === 'user'));
	const hasSelected = $derived(message.labels.some((label) => label.id === selected));
	const inInbox = $derived(message.labels.some((label) => label.id === 'INBOX'));
</script>

<section class="space-y-4" aria-label="Message labels">
	<div class="flex flex-wrap gap-2">
		{#each message.labels as label (label.id)}
			<Badge variant="secondary">{label.name}</Badge>
		{/each}
	</div>
	<div class="flex flex-wrap gap-2">
		<Button
			variant="outline"
			disabled={mailbox.busy()}
			onclick={() => mailbox.label(message.id, 'STARRED', !message.starred)}
		>
			{message.starred ? 'Unstar' : 'Star'}
		</Button>
		<Button
			variant="outline"
			disabled={mailbox.busy()}
			onclick={() => mailbox.label(message.id, 'INBOX', !inInbox)}
		>
			{inInbox ? 'Archive' : 'Move to Inbox'}
		</Button>
		<Button
			variant="outline"
			disabled={mailbox.busy()}
			onclick={() => mailbox.label(message.id, 'UNREAD', !message.unread)}
		>
			{message.unread ? 'Mark read' : 'Mark unread'}
		</Button>
	</div>
	<div class="flex flex-wrap gap-2">
		<Select.Root type="single" bind:value={selected}>
			<Select.Trigger aria-label="Choose a label">
				{userLabels.find((label) => label.id === selected)?.name ?? 'Choose a label'}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each userLabels as label (label.id)}
						<Select.Item value={label.id} label={label.name}>{label.name}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
		<Button
			variant="outline"
			disabled={!selected || mailbox.busy()}
			onclick={() => mailbox.label(message.id, selected, !hasSelected)}
		>
			{hasSelected ? 'Remove label' : 'Add label'}
		</Button>
	</div>
	<div class="space-y-1 text-sm text-muted-foreground" aria-live="polite">
		{#each message.pending as label (label.id)}
			<p>{label.want ? 'Adding' : 'Removing'} {label.name}, waiting to send</p>
		{/each}
		{#each mailbox.sentLabels(message.id) as id (id)}
			<p>{mailbox.labels().find((label) => label.id === id)?.name ?? id}: Sent</p>
		{/each}
	</div>
</section>
