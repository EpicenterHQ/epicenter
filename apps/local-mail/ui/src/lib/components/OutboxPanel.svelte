<script lang="ts">
	/**
	 * Undelivered work, and the reason it is undelivered, in the place that
	 * already says how much of it there is (ADR-0327).
	 *
	 * Everything except the spinner is read from the durable file, so a failure
	 * is still here after the window that saw it was closed and reopened. That is
	 * the whole reason the panel exists: a failure a person was not sitting in
	 * front of used to leave no trace at all.
	 *
	 * Local Mail does not deliver in the background, so this list is honest about
	 * waiting: work sits here until somebody opens the application, acts, or
	 * presses Retry. Nothing on the panel promises otherwise, which is why there
	 * is no "trying again shortly" and no countdown.
	 *
	 * There is nothing per row. Delivery is a pass rather than a queue of
	 * independent errands, so a row that failed did not fail alone, and a person
	 * who wants one row gone is asking to undo the act, which belongs in the
	 * message list.
	 */
	import { gmailSignInNotice } from '#platform/device';
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { Outbox } from '@epicenter/local-mail/outbox';
	import { describeAssertion } from '$lib/actions';
	import { relativeTime } from '$lib/format';
	import type { LabelSummary } from '@epicenter/local-mail/mailbox';

	let {
		outbox,
		reconciling,
		labels,
		onRetry,
		onSignIn,
	}: {
		outbox: Outbox | undefined;
		/** Whether a pass is running in this window right now. */
		reconciling: boolean;
		/** The mirrored label set, so a custom label is named rather than `Label_7`. */
		labels: LabelSummary[];
		/** Try again now. The only control, because delivery is a pass. */
		onRetry: () => void;
		/** Send the person back to Google for the account in view. */
		onSignIn: () => void;
	} = $props();

	const status = $derived(outbox?.status ?? 'clear');
	const waiting = $derived(outbox?.waiting ?? 0);
	const failure = $derived(outbox?.lastPass?.failure ?? null);
	const discarded = $derived(outbox?.lastPass?.discarded ?? []);
	const numberFmt = new Intl.NumberFormat();

	const labelName = (id: string) =>
		labels.find((label) => label.id === id)?.name ?? id;

	/** Current status for the popover, tooltip, and accessible button label. */
	const summary = $derived.by(() => {
		if (reconciling) return 'Syncing';
		const count = numberFmt.format(waiting);
		const plural = waiting === 1 ? 'change' : 'changes';
		switch (status) {
			case 'signin':
				return 'Reconnect to sync';
			case 'failed':
				return 'Sync needs attention';
			case 'waiting':
				return `${count} ${plural} pending`;
			case 'clear':
				return 'Up to date';
		}
	});

	/**
	 * What a person is told about the failure, in their words rather than the
	 * library's. The library states the failure precisely and this decides what
	 * is said about it (ADR-0244); the precise text is available in Error details.
	 */
	const explanation = $derived.by(() => {
		if (failure === null) return null;
		switch (failure.kind) {
			case 'signin':
				if (failure.name === 'CredentialMissing') {
					return 'Reconnect Gmail to resume syncing.';
				}
				return 'Reconnect Gmail to renew access and resume syncing.';
			case 'refused':
				return 'Gmail refused the request. Check the error details before trying again.';
			case 'retry':
				if (failure.name === 'StorageFailed') {
					return 'Local Mail could not access your saved Gmail sign-in. Try again.';
				}
				return 'Sync could not finish. Try again later.';
		}
	});
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				size="sm"
				variant="ghost"
				class="text-muted-foreground"
				aria-label={`Sync: ${summary}`}
				tooltip={summary}
			>
				{#if reconciling}
					<Spinner class="size-3" />
				{:else}
					<span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
				{/if}
				<span>Sync</span>
			</Button>
		{/snippet}
	</Popover.Trigger>

	<Popover.Content align="end" class="w-96 p-0">
		<div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
			<div>
				<p class="text-sm font-medium">Sync</p>
				<p class="text-xs text-muted-foreground" aria-live="polite">{summary}</p>
			</div>
			{#if status === 'signin'}
				<Button size="sm" variant="outline" disabled={reconciling} onclick={onSignIn}>
					Reconnect Gmail
				</Button>
			{:else}
				<Button
					size="sm"
					variant="outline"
					disabled={reconciling}
					onclick={onRetry}
				>
					Sync now
				</Button>
			{/if}
		</div>

		{#if explanation}
			<p class="border-b border-border px-3 py-2 text-xs">
				{explanation}
			</p>
			{#if failure?.kind === 'signin'}
				<p class="border-b border-border px-3 py-2 text-xs text-muted-foreground">
					{gmailSignInNotice}
					{#if waiting > 0} Reconnecting will retry your pending changes.{/if}
				</p>
			{/if}
			{#if failure && failure.name !== 'CredentialMissing'}
				<details class="border-b border-border px-3 py-2 text-xs">
					<summary class="cursor-pointer">Error details</summary>
					<p class="mt-2 whitespace-pre-wrap break-words">{failure.message}</p>
				</details>
			{/if}
		{/if}

		{#if outbox && outbox.entries.length > 0}
			<p class="px-3 pt-3 text-xs font-medium">
				{numberFmt.format(waiting)} pending {waiting === 1 ? 'change' : 'changes'}
			</p>
			<ul class="max-h-72 overflow-y-auto py-1">
				{#each outbox.entries as entry (`${entry.messageId}:${entry.labelId}`)}
					<li class="flex items-baseline gap-3 px-3 py-1.5 text-xs">
						<span class="w-28 shrink-0 font-medium">
							{describeAssertion(entry.labelId, entry.want, labelName(entry.labelId))}
						</span>
						<!--
							A message this device no longer holds is ordinary: undelivered
							triage outlives a cache reset, so the act is still owed even when
							the copy of the mail it names is gone.
						-->
						<span class="min-w-0 flex-1 truncate text-muted-foreground">
							{entry.subject ?? 'Message no longer in this device\'s copy'}
						</span>
						<span class="shrink-0 tabular-nums text-muted-foreground">
							{relativeTime(entry.assertedAt)}
						</span>
					</li>
				{/each}
			</ul>
			{#if outbox.waiting > outbox.entries.length}
				<p class="px-3 pb-2 text-xs text-muted-foreground">
					and {numberFmt.format(outbox.waiting - outbox.entries.length)} more
				</p>
			{/if}
		{:else}
			<p class="px-3 py-4 text-center text-xs text-muted-foreground">
				<!-- Empty is the normal state, and saying so is the point. -->
				No pending changes.
			</p>
		{/if}

		{#if discarded.length > 0}
			<!--
				Assertions Gmail refused individually. They are retired, because they
				can never succeed, and this is where that is said: it used to be a
				toast, which told nobody who was away from the machine.
			-->
			<div class="border-t border-border px-3 py-2">
				<p class="text-xs font-medium">
					Gmail refused {discarded.length}
					{discarded.length === 1 ? 'change' : 'changes'}
				</p>
				<ul class="mt-1 space-y-0.5">
					{#each discarded as one (`${one.messageId}:${one.labelId}`)}
						<li class="truncate text-xs text-muted-foreground" title={one.reason}>
							{describeAssertion(one.labelId, one.want, labelName(one.labelId))}:
							{one.reason}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
