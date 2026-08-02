<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import {
		invert,
		isReversible,
		planToggle,
		type ToggleVerb,
		type TriageAction,
	} from '$lib/actions';
	import LabelRail from '$lib/components/LabelRail.svelte';
	import MessageDetail from '$lib/components/MessageDetail.svelte';
	import MessageList from '$lib/components/MessageList.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { api } from '$lib/api';

	// Default to the inbox: this is a triage surface, and the inbox is the queue.
	let selectedLabel = $state<string | null>('INBOX');
	let search = $state('');
	let selectedId = $state<string | null>(null);
	// Page-owned so the `l` key can open the detail pane's Labels menu.
	let labelsOpen = $state(false);
	let shortcutsOpen = $state(false);

	const queryClient = useQueryClient();

	// The connected accounts the host serves under this one origin. The switcher
	// picks one; every read and write below is scoped to it and keyed by it.
	const accountsQuery = createQuery(() => ({
		queryKey: ['accounts'],
		queryFn: () => api.accounts(),
	}));
	let selectedAccount = $state<string | null>(null);
	// Default to the first account once loaded, and re-resolve if the current
	// selection disappears (an account list can only change across a restart, but
	// this keeps the selection valid without special-casing the first load).
	$effect(() => {
		const list = accountsQuery.data?.accounts ?? [];
		if (list.length === 0) {
			selectedAccount = null;
			return;
		}
		if (!selectedAccount || !list.includes(selectedAccount)) {
			selectedAccount = list[0] ?? null;
		}
	});

	const status = createQuery(() => ({
		queryKey: ['status', selectedAccount],
		queryFn: () => api.status(selectedAccount as string),
		enabled: selectedAccount !== null,
	}));
	const labels = createQuery(() => ({
		queryKey: ['labels', selectedAccount],
		queryFn: () => api.labels(selectedAccount as string),
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
			queryFn: () => api.messages(selectedAccount as string, query),
			enabled: selectedAccount !== null,
		};
	});

	const reconcile = createMutation(() => ({
		mutationFn: () => api.reconcile(selectedAccount as string),
		onSuccess: (outcome) => {
			// The host yields busy when another owner holds this account's
			// reconciler; that owner delivers and pulls, so this is a note, not a
			// failure, and there is nothing new to invalidate.
			if ('reconciled' in outcome) {
				toast.info(outcome.message);
				return;
			}
			const { delivery, pull } = outcome;
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

	/** Re-read what the server now says. Every triage act lands in the server's
	 * durable intent store, and the read models overlay it, so a plain refetch
	 * already shows the act; there is nothing to project in browser memory. */
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
			api.assert(selectedAccount as string, {
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
					action: { label: 'Undo', onClick: () => runOn(v.id, invert(v.action), false) },
				});
			}
		},
		onError: (error: Error) => toast.error(error.message),
		onSettled: () => invalidateReads(),
	}));

	function runOn(id: string, action: TriageAction, undoable: boolean): void {
		if (readOnly) return;
		act.mutate({ id, action, undoable });
	}
	function trashSelected(): void {
		if (!selectedId) return;
		// Trash is an ordinary label here. Only delivery treats it specially,
		// because Gmail gives it its own endpoint.
		runOn(selectedId, { label: 'Moved to trash', addLabels: ['TRASH'], removeLabels: [] }, true);
	}
	/** Dispatch a planned action against the current selection. */
	function dispatch(action: TriageAction): void {
		if (!selectedId) return;
		runOn(selectedId, action, true);
	}

	// The list is exactly what the server returned. There is no client-side
	// projection: the server already composed Gmail's facts with this machine's
	// undelivered triage before it filtered and paged, so the page cannot
	// disagree with the CLI or an agent about what is in the inbox.
	const labelList = $derived(labels.data?.labels ?? []);
	const messageList = $derived(messages.data?.messages ?? []);
	const readOnly = $derived(status.data?.readOnly ?? false);
	// True when the mirror holds no messages at all (nothing pulled yet), as
	// opposed to this label/search view simply matching none. Drives which empty
	// state the list shows: "reconcile" vs "no match".
	const mirrorEmpty = $derived((status.data?.rows.messages ?? 0) === 0);
	const reconcileError = $derived(
		reconcile.error?.message ??
			(reconcile.data && 'delivery' in reconcile.data
				? (reconcile.data.delivery.failure?.message ??
					reconcile.data.pull.failure?.message ??
					null)
				: null),
	);

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

		// Action keys obey the same read-only gate as the buttons.
		if (readOnly) return;
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
			trashSelected();
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
		accounts={accountsQuery.data?.accounts ?? []}
		{selectedAccount}
		onSelectAccount={(account) => {
			selectedAccount = account;
			selectedId = null;
			labelsOpen = false;
		}}
		reconciling={reconcile.isPending}
		{reconcileError}
		onReconcile={() => {
			if (selectedAccount) reconcile.mutate();
		}}
	/>

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
				{readOnly}
				labels={labelList}
				busy={act.isPending}
				{labelsOpen}
				onDispatch={dispatch}
				onTrash={trashSelected}
				onLabelsOpenChange={(open) => (labelsOpen = open)}
			/>
		{/key}
	</div>
</div>

<Dialog.Root open={shortcutsOpen} onOpenChange={(open) => (shortcutsOpen = open)}>
	<Dialog.Content class="max-w-sm">
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
