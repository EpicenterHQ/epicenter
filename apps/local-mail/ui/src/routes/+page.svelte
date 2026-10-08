<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import {
		invert,
		isReversible,
		MOVE_TO_TRASH,
		planToggle,
		type ToggleVerb,
		type TriageAction,
	} from '$lib/actions';
	import LabelRail from '$lib/components/LabelRail.svelte';
	import MessageDetail from '$lib/components/MessageDetail.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import ConnectPanel from '$lib/components/ConnectPanel.svelte';
	import RemoveAccountDialog from '$lib/components/RemoveAccountDialog.svelte';
	import { mail } from '$lib/mail';

	// Default to the inbox: this is a triage surface, and the inbox is the queue.
	let selectedLabel = $state<string | null>('INBOX');
	let search = $state('');
	let selectedId = $state<string | null>(null);
	// Page-owned so the `l` key can open the detail pane's Labels menu.
	let labelsOpen = $state(false);
	let shortcutsOpen = $state(false);
	// The account a person asked to remove, which is what opens the dialog that
	// decides what removing it costs.
	let removing = $state<{ sub: string; email: string } | null>(null);
	// Connecting from the menu is the same flow the empty state runs, so the
	// panel owns it and this only says whether it is on screen.
	let connecting = $state(false);

	const queryClient = useQueryClient();

	// The accounts this person has connected. The switcher picks one; every read
	// and write below is scoped to its Epicenter row id and keyed by it.
	const accountsQuery = createQuery(() => ({
		queryKey: ['accounts'],
		queryFn: () => mail.accounts(),
	}));
	let selectedAccount = $state<string | null>(null);
	// Default to the first account once loaded, and re-resolve if the current
	// selection disappears, which is what removing one looks like.
	$effect(() => {
		const list = accountsQuery.data ?? [];
		if (list.length === 0) {
			selectedAccount = null;
			return;
		}
		if (!selectedAccount || !list.some((a) => a.sub === selectedAccount)) {
			selectedAccount = list[0]?.sub ?? null;
		}
	});

	// The only query that polls. Status is the health surface: the pending count
	// and the age of the oldest change without anyone touching the page. Matched
	// to the reconcile interval, so a clean pass and the reading of it move
	// together.
	const status = createQuery(() => ({
		queryKey: ['status', selectedAccount],
		queryFn: () => mail.status(selectedAccount as string),
		enabled: selectedAccount !== null,
		refetchInterval: 30_000,
	}));
	const labels = createQuery(() => ({
		queryKey: ['labels', selectedAccount],
		queryFn: () => mail.labels(selectedAccount as string),
		enabled: selectedAccount !== null,
	}));
	const messages = createQuery(() => {
		const query = {
			label: selectedLabel ?? undefined,
			search: search.trim() || undefined,
			limit: 100,
		};
		return {
			queryKey: ['messages', selectedAccount, query],
			queryFn: () => mail.messages(selectedAccount as string, query),
			enabled: selectedAccount !== null,
		};
	});

	const reconcile = createMutation(() => ({
		mutationFn: () => mail.reconcile(selectedAccount as string),
		onSuccess: (outcome) => {
			// The host yields busy when another owner holds this account's
			// reconciler; that owner delivers and pulls, so this is a note, not a
			// failure, and there is nothing new to invalidate.
			if ('reconciled' in outcome) {
				toast.info(outcome.message);
				return;
			}
			const { delivery, pull } = outcome;
			// Gmail refused these outright, so they are gone. This toast is the only
			// place they are ever reported: nothing durable records a refusal, so
			// saying it once, here, is the whole contract.
			if (delivery.discarded.length > 0) {
				toast.warning(`Gmail refused ${delivery.discarded.length} change(s)`, {
					description: delivery.discarded
						.map((d) => `${d.want ? 'add' : 'remove'} ${d.labelId}: ${d.reason}`)
						.join('\n'),
					duration: 12_000,
				});
			}
			if (delivery.failure) {
				toast.error(`Could not reach Gmail: ${delivery.failure.message}`, {
					description: `${delivery.retained} change(s) still pending. Nothing was lost.`,
				});
			} else if (pull.failure) {
				toast.error(`Refresh failed: ${pull.failure.message}`);
			} else {
				const sent = delivery.delivered
					? `${delivery.delivered} change(s) sent, `
					: '';
				toast.success(
					`${sent}${pull.messagesUpserted} upserted, ${pull.messagesDeleted} deleted, ${pull.labelsPatched} labels patched`,
				);
			}
			invalidateReads();
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	/** Re-read. Every triage act lands in the durable intent store and the read
	 * models overlay it, so a plain refetch already shows the act; there is
	 * nothing to project in browser memory. */
	function invalidateReads(): void {
		queryClient.invalidateQueries({ queryKey: ['messages'] });
		queryClient.invalidateQueries({ queryKey: ['message'] });
		queryClient.invalidateQueries({ queryKey: ['status'] });
		queryClient.invalidateQueries({ queryKey: ['labels'] });
	}

	// The one write path. Both the toolbar (via `onDispatch`) and the keyboard
	// call this; the read-only gate and the undo toast live here alone. `id` is
	// explicit so Undo targets the original message even after the selection has
	// moved on. Undo is the inverse assertion: it replaces the pending one, and
	// wins even against a delivery already in flight.
	type ActVars = { id: string; action: TriageAction; undoable: boolean };
	const act = createMutation(() => ({
		mutationFn: (v: ActVars) =>
			mail.assert(selectedAccount as string, {
				ids: [v.id],
				addLabels: v.action.addLabels,
				removeLabels: v.action.removeLabels,
			}),
		onSuccess: (_outcome, v) => {
			// Success is self-evident from the effect (the row leaves, chips update),
			// so the only element that earns a toast is Undo. The undo act itself is
			// not undoable, and fires silently.
			if (v.undoable && isReversible(v.action)) {
				toast.success(v.action.label, {
					action: {
						label: 'Undo',
						onClick: () => runOn(v.id, invert(v.action), false),
					},
				});
			}
		},
		onError: (error: Error) => toast.error(error.message),
		onSettled: () => invalidateReads(),
	}));

	function runOn(id: string, action: TriageAction, undoable: boolean): void {
		act.mutate({ id, action, undoable });
	}
	/** Dispatch a planned action against the current selection. */
	function dispatch(action: TriageAction): void {
		if (!selectedId) return;
		runOn(selectedId, action, true);
	}

	// The list is exactly what the read model returned. There is no client-side
	// projection: the overlay composed Gmail's facts with this machine's
	// undelivered triage before the query filtered and paged, so the page cannot
	// disagree with a background pass about what is in the inbox.
	const labelList = $derived(labels.data?.labels ?? []);
	const messageList = $derived(messages.data?.messages ?? []);
	// True when the cache holds no messages at all (nothing pulled yet), as
	// opposed to this label or search view simply matching none. Drives which
	// empty state the list shows: "reconcile" against "no match".
	const mirrorEmpty = $derived((status.data?.rows.messages ?? 0) === 0);
	const reconcileFailure = $derived(
		reconcile.data && 'delivery' in reconcile.data
			? (reconcile.data.delivery.failure ?? reconcile.data.pull.failure ?? null)
			: null,
	);
	const reconcileError = $derived(
		reconcile.error?.message ?? reconcileFailure?.message ?? null,
	);
	/**
	 * Google stopped honouring this account's grant, which is the one state
	 * where an account outlives its credential (ADR-0320). Nobody chose it, so
	 * it is shown rather than offered, and signing in again lands on the same
	 * account and delivers what was waiting.
	 */
	const signInExpired = $derived(reconcileFailure?.name === 'ReauthRequired');

	// Keep the selection valid: default to the first row, and re-resolve when a
	// filter change drops the current selection out of the list.
	$effect(() => {
		if (messageList.length === 0) {
			selectedId = null;
			return;
		}
		if (!selectedId || !messageList.some((m) => m.id === selectedId)) {
			selectedId = messageList[0]?.id ?? null;
		}
	});

	// --- Keyboard triage -----------------------------------------------------
	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
	}
	function moveSelection(delta: number): void {
		if (messageList.length === 0) return;
		const idx = messageList.findIndex((m) => m.id === selectedId);
		const next = Math.min(
			Math.max((idx === -1 ? 0 : idx) + delta, 0),
			messageList.length - 1,
		);
		selectedId = messageList[next]?.id ?? null;
	}
	function keyToggle(verb: ToggleVerb): void {
		const summary = messageList.find((m) => m.id === selectedId);
		if (summary) dispatch(planToggle(summary.labelIds, verb));
	}
	function onKeydown(e: KeyboardEvent): void {
		// `?` toggles the shortcuts overlay from anywhere but a text field.
		if (e.key === '?' && !isTypingTarget(e.target)) {
			shortcutsOpen = !shortcutsOpen;
			e.preventDefault();
			return;
		}
		// Never hijack typing; let an open menu or overlay own the keyboard.
		if (isTypingTarget(e.target) || shortcutsOpen || labelsOpen) return;

		// Navigation is pure client selection, so it is safe in read-only mode.
		if (e.key === 'j' || e.key === 'ArrowDown') {
			moveSelection(1);
			e.preventDefault();
			return;
		}
		if (e.key === 'k' || e.key === 'ArrowUp') {
			moveSelection(-1);
			e.preventDefault();
			return;
		}
		if (e.key === '/') {
			document.getElementById('mirror-search')?.focus();
			e.preventDefault();
			return;
		}

		if (e.key === 'e') {
			keyToggle('inbox');
			e.preventDefault();
		} else if (e.key === 's') {
			keyToggle('star');
			e.preventDefault();
		} else if (e.key === 'U') {
			keyToggle('read');
			e.preventDefault();
		} else if (e.key === 'l') {
			labelsOpen = true;
			e.preventDefault();
		} else if (e.key === '#') {
			// Gmail's own trash key. Shift-guarded already: `#` is never produced
			// while typing here because the text-field guard returned above.
			dispatch(MOVE_TO_TRASH);
			e.preventDefault();
		}
	}

	const shortcuts: { keys: string[]; label: string }[] = [
		{ keys: ['j'], label: 'Next message' },
		{ keys: ['k'], label: 'Previous message' },
		{ keys: ['e'], label: 'Archive / move to inbox' },
		{ keys: ['s'], label: 'Star / unstar' },
		{ keys: ['⇧', 'U'], label: 'Mark unread / read' },
		{ keys: ['#'], label: 'Move to trash' },
		{ keys: ['l'], label: 'Labels menu' },
		{ keys: ['/'], label: 'Search' },
		{ keys: ['?'], label: 'This help' },
	];
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col">
	<StatusBar
		status={status.data}
		accounts={accountsQuery.data ?? []}
		{selectedAccount}
		onSelectAccount={(account) => {
			selectedAccount = account;
			selectedId = null;
			labelsOpen = false;
		}}
		reconciling={reconcile.isPending}
		{reconcileError}
		{signInExpired}
		onSignIn={() => (connecting = true)}
		onReconcile={() => {
			if (selectedAccount) reconcile.mutate();
		}}
		onConnectAnother={() => (connecting = true)}
		onRemoveAccount={() => {
			const account = (accountsQuery.data ?? []).find(
				(candidate) => candidate.sub === selectedAccount,
			);
			if (account) removing = { sub: account.sub, email: account.email };
		}}
	/>

	{#if (accountsQuery.data ?? []).length === 0 || connecting}
		<ConnectPanel
			loading={accountsQuery.isPending}
			another={connecting}
			onConnected={() => {
				connecting = false;
				queryClient.invalidateQueries({ queryKey: ['accounts'] });
			}}
			onCancel={() => (connecting = false)}
		/>
	{:else}
	<div class="flex min-h-0 flex-1">
		<LabelRail
			labels={labelList}
			{selectedLabel}
			{search}
			onSelect={(id) => (selectedLabel = id)}
			onSearch={(value) => (search = value)}
		/>

		<MessageList
			messages={messageList}
			labels={labelList}
			{selectedId}
			loading={messages.isPending}
			error={messages.error?.message ?? null}
			{mirrorEmpty}
			onSelect={(id) => (selectedId = id)}
		/>

		{#key selectedId}
			<MessageDetail
				id={selectedId}
				account={selectedAccount}
				labels={labelList}
				busy={act.isPending}
				{labelsOpen}
				onDispatch={dispatch}
				onLabelsOpenChange={(open) => (labelsOpen = open)}
			/>
		{/key}
	</div>
	{/if}
</div>

<RemoveAccountDialog
	account={removing}
	onClose={() => (removing = null)}
	onRemoved={() => {
		// The switcher re-resolves to whatever is left, and to nothing when this
		// was the last account, which is the connect panel again.
		selectedAccount = null;
		selectedId = null;
		queryClient.invalidateQueries({ queryKey: ['accounts'] });
	}}
/>

<Dialog.Root open={shortcutsOpen} onOpenChange={(open) => (shortcutsOpen = open)}>
	<Dialog.Content class="max-w-sm sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description>Triage without leaving the keyboard.</Dialog.Description>
		</Dialog.Header>
		<dl class="mt-2 space-y-1.5">
			{#each shortcuts as row (row.label)}
				<div class="flex items-center justify-between gap-4 text-sm">
					<dt class="text-muted-foreground">{row.label}</dt>
					<dd class="flex items-center gap-1">
						{#each row.keys as key (key)}
							<Kbd>{key}</Kbd>
						{/each}
					</dd>
				</div>
			{/each}
		</dl>
	</Dialog.Content>
</Dialog.Root>
