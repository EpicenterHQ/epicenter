<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { approvalEntries } from '../approvals.js';
	import type { VoiceQueue } from '../queue.svelte.js';

	let { queue, onSelect, excludeThreadId = null }: {
		queue: VoiceQueue;
		onSelect: (id: string) => void;
		excludeThreadId?: string | null;
	} = $props();
	const entries = $derived(approvalEntries(queue.state?.approvals ?? [], queue.threads, excludeThreadId));
</script>

{#if entries.length}
	<Alert.Root>
		<Alert.Title>{entries.length} approvals waiting</Alert.Title>
		<Alert.Description>
			<ul class="max-h-40 space-y-2 overflow-y-auto">
				{#each entries as { approval, title } (approval.id)}
					<li class="flex min-w-0 items-center gap-2">
						<span class="min-w-0 flex-1 break-words">{title}: {approval.kind === 'command' ? 'Command' : 'File change'}</span>
						<Button size="sm" variant="outline" onclick={() => onSelect(approval.threadId)}>Open</Button>
					</li>
				{/each}
			</ul>
		</Alert.Description>
	</Alert.Root>
{/if}
