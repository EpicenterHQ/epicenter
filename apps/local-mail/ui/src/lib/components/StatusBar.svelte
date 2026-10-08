<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { Spinner } from '@epicenter/ui/spinner';
	import AlertTriangleIcon from '@lucide/svelte/icons/triangle-alert';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
		import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { relativeTime } from '$lib/format';
	import type { ConnectedAccount, MailboxStatus } from '$lib/types';

	let {
		status,
		accounts,
		selectedAccount,
		onSelectAccount,
		reconciling,
		reconcileError,
		signInExpired,
		onReconcile,
		onSignIn,
		onConnectAnother,
		onRemoveAccount,
	}: {
		status: MailboxStatus | undefined;
		/** Every account this person has connected. One renders as plain text;
		 * several render as a switcher. */
		accounts: ConnectedAccount[];
		/** The account currently in view (null only before the list has loaded). */
		selectedAccount: string | null;
		onSelectAccount: (account: string) => void;
		reconciling: boolean;
		reconcileError: string | null;
		/** Google stopped honouring the grant, so this account cannot sync. */
		signInExpired: boolean;
		onReconcile: () => void;
		/** Send the person back to Google for the account already in view. */
		onSignIn: () => void;
		/** Send the person to Google for one more account. */
		onConnectAnother: () => void;
		/** Ask to remove the account in view. What that costs is decided there. */
		onRemoveAccount: () => void;
	} = $props();

	// Local triage Gmail has not been told about yet. Two numbers, no list: the
	// point is that undelivered work is never invisible, not that this becomes a
	// place to manage it.
	const pending = $derived(status?.pending.assertions ?? 0);
	const oldestPending = $derived(status?.pending.oldestAssertedAt ?? null);

	// The cache chip is the one canonical cache-state surface.
	const cache = $derived(status?.cache ?? 'empty');
	const chip = $derived({
		tone:
			cache === 'ready'
				? 'bg-emerald-500'
				: cache === 'building'
					? 'bg-amber-500'
					: 'bg-muted-foreground',
		label: cache,
	});
	const selectedEmail = $derived(
		accounts.find((account) => account.sub === selectedAccount)?.email ??
			null,
	);
	const numberFmt = new Intl.NumberFormat();
</script>

<header
	class="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4"
>
	<div class="flex items-center gap-3 min-w-0">
		<span class="text-sm font-semibold tracking-tight">Local Mail</span>
		{#if accounts.length > 0}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							size="sm"
							variant="ghost"
							class="h-7 min-w-0 gap-1.5 px-2 font-mono text-xs text-muted-foreground"
							tooltip={accounts.length > 1 ? 'Switch account' : 'Accounts'}
						>
							<span class="truncate">{selectedEmail ?? 'Select account'}</span>
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
						{#each accounts as account (account.sub)}
							<DropdownMenu.RadioItem value={account.sub} closeOnSelect>
								<span class="truncate font-mono text-xs">{account.email}</span>
							</DropdownMenu.RadioItem>
						{/each}
					</DropdownMenu.RadioGroup>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={onConnectAnother}>
						<PlusIcon class="size-3.5" />
						Connect another account
					</DropdownMenu.Item>
					{#if selectedEmail}
						<DropdownMenu.Item variant="destructive" onSelect={onRemoveAccount}>
							<Trash2Icon class="size-3.5" />
							Remove {selectedEmail}...
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</div>

	<div class="flex items-center gap-3 text-xs text-muted-foreground">
		{#if status}
			<span class="flex items-center gap-1.5" title="Cache state">
				<span class="size-2 rounded-full {chip.tone}"></span>
				<span class="capitalize">{chip.label}</span>
			</span>
			<span class="tabular-nums">
				{numberFmt.format(status.rows.messages)} msgs · {status.rows.labels} labels
			</span>
			<span class="tabular-nums" title={status.lastSyncedAt ?? 'never synced'}>
				synced {relativeTime(status.lastSyncedAt)}
			</span>
			{#if signInExpired}
				<!--
					Not an error a retry fixes and not a state a person chose. It says
					what is at stake, because the pending count is work Gmail has not
					been told about and cannot be until this is answered (ADR-0320).
				-->
				<span
					class="flex items-center gap-1.5 rounded border border-destructive/40 px-1.5 py-0.5 font-medium text-destructive"
				>
					<AlertTriangleIcon class="size-3" />
					Sign-in expired{pending > 0
						? ` · ${numberFmt.format(pending)} ${pending === 1 ? 'change' : 'changes'} waiting`
						: ''}
				</span>
				<Button size="sm" variant="outline" class="h-7" onclick={onSignIn}>
					{pending > 0 ? 'Sign in to deliver' : 'Sign in'}
				</Button>
			{:else if pending > 0}
				<span
					class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium text-amber-500 tabular-nums"
					title="Changes recorded here that Gmail has not been told about yet. The reconciler delivers them; nothing is lost if this app closes first."
				>
					<ClockIcon class="size-3" />
					{pending} pending · {relativeTime(oldestPending)}
				</span>
			{/if}
		{/if}
		<!--
			An expired sign-in already says what happened and what to do about it,
			so this would be the same fact twice, in weaker words.
		-->
		{#if reconcileError && !signInExpired}
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
		<LightSwitch variant="ghost" />
	</div>
</header>
