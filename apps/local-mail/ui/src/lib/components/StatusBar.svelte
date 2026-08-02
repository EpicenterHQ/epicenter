<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { Spinner } from '@epicenter/ui/spinner';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { relativeTime } from '$lib/format';
	import type { MailboxStatus } from '$lib/types';

	let {
		status,
		accounts,
		selectedAccount,
		onSelectAccount,
		reconciling,
		reconcileError,
		onReconcile,
	}: {
		status: MailboxStatus | undefined;
		/** Every connected account the host serves. One account renders as plain
		 * text; several render as a switcher. */
		accounts: string[];
		/** The account currently in view (null only before the list has loaded). */
		selectedAccount: string | null;
		onSelectAccount: (account: string) => void;
		reconciling: boolean;
		reconcileError: string | null;
		onReconcile: () => void;
	} = $props();

	// Local triage Gmail has not been told about yet. Two numbers, no list: the
	// point is that undelivered work is never invisible, not that this becomes a
	// place to manage it.
	const pending = $derived(status?.pending.assertions ?? 0);
	const oldestPending = $derived(status?.pending.oldestAssertedAt ?? null);

	// The mirror chip is the one canonical mirror-state surface.
	const mirror = $derived(status?.mirror ?? 'empty');
	const chip = $derived({
		tone:
			mirror === 'ready'
				? 'bg-emerald-500'
				: mirror === 'building'
					? 'bg-amber-500'
					: 'bg-muted-foreground',
		label: mirror,
	});
	const numberFmt = new Intl.NumberFormat();
</script>

<header
	class="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4"
>
	<div class="flex items-center gap-3 min-w-0">
		<span class="text-sm font-semibold tracking-tight">Local Mail</span>
		{#if accounts.length > 1}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							variant="ghost"
							class="h-7 min-w-0 gap-1.5 px-2 font-mono text-xs text-muted-foreground"
							tooltip="Switch account"
						>
							<span class="truncate">{selectedAccount ?? 'Select account'}</span>
							<ChevronsUpDownIcon class="size-3.5 shrink-0" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-64">
					<DropdownMenu.Label>Accounts</DropdownMenu.Label>
					<DropdownMenu.Separator />
					<DropdownMenu.RadioGroup
						value={selectedAccount ?? ''}
						onValueChange={onSelectAccount}
					>
						{#each accounts as account (account)}
							<DropdownMenu.RadioItem value={account}>
								<span class="truncate font-mono text-xs">{account}</span>
							</DropdownMenu.RadioItem>
						{/each}
					</DropdownMenu.RadioGroup>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{:else if selectedAccount}
			<span class="truncate font-mono text-xs text-muted-foreground">
				{selectedAccount}
			</span>
		{/if}
	</div>

	<div class="flex items-center gap-3 text-xs text-muted-foreground">
		{#if status}
			<span class="flex items-center gap-1.5" title="Mirror state">
				<span class="size-2 rounded-full {chip.tone}"></span>
				<span class="capitalize">{chip.label}</span>
			</span>
			<span class="tabular-nums">
				{numberFmt.format(status.rows.messages)} msgs · {status.rows.labels} labels
			</span>
			<span class="tabular-nums" title={status.lastSyncedAt ?? 'never synced'}>
				synced {relativeTime(status.lastSyncedAt)}
			</span>
			{#if pending > 0}
				<span
					class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium text-amber-500 tabular-nums"
					title="Changes recorded here that Gmail has not been told about yet. The reconciler delivers them; nothing is lost if this app closes first."
				>
					<ClockIcon class="size-3" />
					{pending} pending · {relativeTime(oldestPending)}
				</span>
			{/if}
			{#if status.readOnly}
				<span
					class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium text-amber-500"
					title="LOCAL_MAIL_READ_ONLY is set: Gmail writes are disabled"
				>
					<LockIcon class="size-3" /> read-only
				</span>
			{/if}
		{/if}
		{#if reconcileError}
			<span
				class="flex items-center gap-1 text-destructive"
				title={reconcileError}
			>
				<AlertTriangleIcon class="size-3.5" /> reconcile failed
			</span>
		{/if}
		<Button
			size="sm"
			variant="outline"
			onclick={onReconcile}
			disabled={reconciling}
			tooltip="Send pending changes and poll Gmail now"
		>
			{#if reconciling}
				<Spinner class="size-3.5" />
			{:else}
				<RefreshCwIcon class="size-3.5" />
			{/if}
			<span>Reconcile</span>
		</Button>
	</div>
</header>
