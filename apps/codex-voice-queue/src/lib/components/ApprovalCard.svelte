<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { PendingApproval } from '../api-types.js';

	let { approval, onDecide }: {
		approval: PendingApproval;
		onDecide: (id: string, decision: 'accept' | 'decline') => Promise<void>;
	} = $props();
	let pending = $state(false);
	let error = $state<string | null>(null);

	async function decide(decision: 'accept' | 'decline') {
		pending = true;
		error = null;
		try {
			await onDecide(approval.id, decision);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			pending = false;
		}
	}
</script>

<Alert.Root>
	<Alert.Title>
		{approval.kind === 'command' ? 'Command needs approval' : 'File change needs approval'}
	</Alert.Title>
	<Alert.Description>
		{#if approval.command}
			<pre class="whitespace-pre-wrap break-all font-mono">{approval.command}</pre>
		{/if}
		{#if approval.cwd}
			<p class="break-all font-mono">{approval.cwd}</p>
		{/if}
		{#if approval.reason}
			<p class="font-mono">{approval.reason}</p>
		{/if}
		{#if approval.grantRoot}
			<p class="break-all font-mono">Codex also asked to write under {approval.grantRoot} for the rest of this session. Approving here answers this one request; whether Codex applies the wider access is not guaranteed.</p>
		{/if}
		{#if approval.networkHost}
			<p class="break-all font-mono">Network host: {approval.networkHost}</p>
		{/if}
		{#if approval.kind === 'fileChange'}
			{#each approval.changes ?? [] as change, index (index)}
				<div class="space-y-1">
					<p class="break-words font-mono [overflow-wrap:anywhere]">{change.path}</p>
					<p class="break-words [overflow-wrap:anywhere]">{{ add: 'Add', delete: 'Delete', update: 'Update' }[change.kind.type]}{change.kind.type === 'update' && change.kind.move_path ? `, moved to ${change.kind.move_path}` : ''}</p>
					<details><summary>Show diff</summary><pre class="max-h-80 overflow-x-auto overflow-y-auto">{change.diff}</pre></details>
				</div>
			{/each}
			{#if approval.changesTruncated}<p>Diff truncated. Open Codex to see the full patch.</p>{/if}
			{#if !approval.changes?.length}<p>Codex has not shared the file changes for this request. Decline it here, or review and approve it in Codex.</p>{/if}
		{/if}
		{#if error}<p role="alert" class="text-destructive">{error}</p>{/if}
		<div class="mt-3 flex gap-2">
			<Button disabled={pending || (approval.kind === 'fileChange' && !approval.changes?.length)} onclick={() => decide('accept')}>
				{#if pending}
					<Spinner />
				{/if}
				{approval.kind === 'fileChange' ? 'Approve these changes' : 'Approve once'}
			</Button>
			<Button variant="outline" disabled={pending} onclick={() => decide('decline')}>
				Decline
			</Button>
		</div>
	</Alert.Description>
</Alert.Root>
