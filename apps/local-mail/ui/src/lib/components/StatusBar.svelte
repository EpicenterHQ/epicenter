<script lang="ts">
	/**
	 * The account in view, how much of its mail this device holds, and the way
	 * into the outbox.
	 *
	 * Undelivered work is not described here any more, in any form. It is the
	 * outbox panel's, whole: one thing says how much is waiting and why, and it
	 * reads the same after a reload as before one (ADR-0327). This bar used to
	 * carry a pending chip, a sign-in warning, and a "reconcile failed" marker,
	 * all three derived from a mutation that had just run in this page, and all
	 * three gone the moment the page reloaded.
	 */
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { Outbox } from '@epicenter/local-mail/outbox';
	import OutboxPanel from './OutboxPanel.svelte';
	import { relativeTime } from '$lib/format';
	import type { ConnectedAccount } from '@epicenter/local-mail/accounts';
	import type {
		LabelSummary,
		MailStatus,
	} from '@epicenter/local-mail/mailbox';

	let {
		status,
		outbox,
		reconciling,
		blocked,
		labels,
		accounts,
		selectedAccount,
		onSelectAccount,
		onRetry,
		onSignIn,
		onConnectAnother,
		onRemoveAccount,
	}: {
		status: MailStatus | undefined;
		/** The outbox for the account in view. */
		outbox: Outbox | undefined;
		/** Whether this window is running a pass right now. Not on the outbox,
		 * because the outbox is durable and this is not. */
		reconciling: boolean;
		/**
		 * The accounts whose work cannot move without a person, so the switcher can
		 * mark one. A person choosing accounts should not be surprised (ADR-0327).
		 */
		blocked: ReadonlySet<string>;
		labels: LabelSummary[];
		/** Every account this person has connected. One renders as plain text;
		 * several render as a switcher. */
		accounts: ConnectedAccount[];
		/** The account currently in view (null only before the list has loaded). */
		selectedAccount: string | null;
		onSelectAccount: (account: string) => void;
		/** Try again now, which is the outbox's only control. */
		onRetry: () => void;
		/** Send the person back to Google for the account already in view. */
		onSignIn: () => void;
		/** Send the person to Google for one more account. */
		onConnectAnother: () => void;
		/** Ask to remove the account in view. What that costs is decided there. */
		onRemoveAccount: () => void;
	} = $props();

	// The cache chip is the one canonical cache-state surface.
	const cache = $derived(status?.cache ?? 'empty');
	const chip = $derived({
		tone:
			cache === 'ready'
				? 'bg-emerald-500'
				: cache === 'building'
					? 'bg-amber-500'
					: 'bg-muted-foreground',
		label: cache === 'building' && !reconciling ? 'Sync incomplete' : cache,
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
							<DropdownMenu.RadioItem value={account.sub}>
								<span class="truncate font-mono text-xs">{account.email}</span>
								{#if blocked.has(account.sub)}
									<span class="ml-auto size-1.5 rounded-full bg-muted-foreground" role="img" aria-label="Sync needs attention"></span>
								{/if}
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
				{#if status.lastSyncedAt}
					Synced {relativeTime(status.lastSyncedAt)}
				{:else}
					No completed sync
				{/if}
			</span>
		{/if}
		<OutboxPanel {outbox} {reconciling} {labels} {onRetry} {onSignIn} />
		<LightSwitch variant="ghost" />
	</div>
</header>
