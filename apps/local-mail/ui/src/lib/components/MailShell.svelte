<script lang="ts">
	import type { openMailResources } from '$lib/resources.js';
	import { onDestroy } from 'svelte';
	import { Button } from '@epicenter/ui/button';
	import SavedQueries from '$lib/components/SavedQueries.svelte';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import {
		createMutation,
		createQuery,
		useIsMutating,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import {
		invert,
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
	import { attachMail, mail } from '$lib/mail';

	let { app }: { app: Awaited<ReturnType<typeof openMailResources>> } = $props();
	// svelte-ignore state_referenced_locally
	const closeMail = attachMail(app);
	onDestroy(() => {
		closeMail();
		queryClient.clear();
	});
	let view = $state<'mail' | 'queries'>('mail');
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
	function connectAccount() {
		view = 'mail';
		connecting = true;
	}

	const queryClient = useQueryClient();

	// The accounts this person has connected. The switcher picks one; every read
	// and write below is scoped to its Google subject and keyed by it.
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

	// Count every pending call for the displayed account. Undo can sync another
	// account without changing this indicator.
	const accountSyncs = useIsMutating({
		mutationKey: ['mail', 'reconcile'],
		predicate: (mutation) => mutation.state.variables === selectedAccount,
	});

	// How much of Gmail this device holds, and how fresh it is. What a person
	// still owes Gmail is the outbox below, not this.
	const status = createQuery(() => ({
		queryKey: ['status', selectedAccount],
		queryFn: () => mail.status(selectedAccount as string),
		enabled: selectedAccount !== null,
		refetchInterval: accountSyncs.current > 0 ? 1_000 : 30_000,
	}));
	/**
	 * The outbox for the account in view.
	 *
	 * Nothing writes to it except a pass this page ran, so the reliable signal is
	 * `invalidateReads` after that pass. The poll is a backstop for a second
	 * window over the same file, which is a shape this application does not have
	 * today and costs one local SQLite read to survive.
	 */
	const outbox = createQuery(() => ({
		queryKey: ['outbox', selectedAccount],
		queryFn: () => mail.outbox(selectedAccount as string),
		enabled: selectedAccount !== null,
		refetchInterval: 15_000,
	}));
	/** Which accounts are stuck, so the switcher can mark them. */
	const blocked = createQuery(() => {
		const subs = (accountsQuery.data ?? []).map((one) => one.sub);
		return {
			queryKey: ['outbox', 'blocked', subs],
			queryFn: () => mail.blocked(subs),
			enabled: subs.length > 0,
			refetchInterval: 30_000,
		};
	});
	const labels = createQuery(() => ({
		queryKey: ['labels', selectedAccount],
		queryFn: () => mail.labels(selectedAccount as string),
		refetchInterval: accountSyncs.current > 0 ? 1_000 : false,
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
			refetchInterval: accountSyncs.current > 0 ? 1_000 : false,
			enabled: selectedAccount !== null,
		};
	});

	/**
	 * One reconcile pass, which is the only way one ever starts.
	 *
	 * Three things ask for it and all three are a person: opening the
	 * application, recording triage, and pressing Retry. There is no timer and
	 * no background half, so owed work that misses all three waits in the outbox
	 * until the next time this application is opened.
	 *
	 * It reports nothing itself. The pass writes what it did to durable storage
	 * before it resolves and the outbox is already reading that, so a toast here
	 * would be the same sentence somewhere weaker: it would scroll away, and it
	 * would say nothing at all to a person who had stepped away.
	 */
	const reconcile = createMutation(() => ({
		mutationKey: ['mail', 'reconcile'],
		mutationFn: (sub: string) => mail.reconcile(sub),
		onSettled: () => invalidateReads(),
		onError: (error: Error) => toast.error(error.message),
	}));

	/**
	 * Opening the application delivers what was owed when it was last closed.
	 *
	 * Once per account per page, tracked here rather than by the reconciler,
	 * because "have I already done this since the window opened" is a fact about
	 * this window. Switching to an account counts as opening it, since it is the
	 * first time this page has looked at that mailbox.
	 */
	const opened = new Set<string>();
	$effect(() => {
		const account = selectedAccount;
		if (account === null || opened.has(account)) return;
		opened.add(account);
		reconcile.mutate(account);
	});

	/** Re-read. Every triage act lands in the durable intent store and the read
	 * models overlay it, so a plain refetch already shows the act; there is
	 * nothing to project in browser memory. */
	function invalidateReads(): void {
		queryClient.invalidateQueries({ queryKey: ['messages'] });
		queryClient.invalidateQueries({ queryKey: ['message'] });
		queryClient.invalidateQueries({ queryKey: ['status'] });
		queryClient.invalidateQueries({ queryKey: ['labels'] });
		queryClient.invalidateQueries({ queryKey: ['outbox'] });
	}

	// The one write path. Both the toolbar (via `onDispatch`) and the keyboard
	// call this; the undo toast lives here alone. Capture the account and message
	// together so Undo keeps its target after the selection changes.
	type ActVars = {
		sub: string;
		id: string;
		action: TriageAction;
		undoable: boolean;
	};
	const act = createMutation(() => ({
		mutationFn: (v: ActVars) =>
			mail.assert(v.sub, {
				messageId: v.id,
				labelId: v.action.labelId,
				want: v.action.want,
			}),
		onSuccess: (_outcome, v) => {
			invalidateReads();
			// Deliver only after the local choice has committed.
			reconcile.mutate(v.sub);
			// Success is self-evident from the effect (the row leaves, chips update),
			// so the only element that earns a toast is Undo. The undo act itself is
			// not undoable, and fires silently.
			if (v.undoable) {
				toast.success(v.action.label, {
					action: {
						label: 'Undo',
						onClick: () =>
							act.mutate({ ...v, action: invert(v.action), undoable: false }),
					},
				});
			}
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	/** Dispatch a planned action against the current account and selection. */
	function dispatch(action: TriageAction): void {
		if (selectedAccount === null || !selectedId) return;
		act.mutate({
			sub: selectedAccount,
			id: selectedId,
			action,
			undoable: true,
		});
	}

	// The list is exactly what the read model returned. There is no client-side
	// projection: the overlay composed Gmail's facts with this machine's
	// undelivered triage before the query filtered and paged, so the page cannot
	// disagree with a pass about what is in the inbox.
	const labelList = $derived(labels.data ?? []);
	const messageList = $derived(messages.data ?? []);
	// True when the cache holds no messages at all (nothing pulled yet), as
	// opposed to this label or search view simply matching none. Drives which
	// empty state the list shows: "reconcile" against "no match".
	const mirrorEmpty = $derived((status.data?.rows.messages ?? 0) === 0);
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
		if (view !== 'mail') return;
		// `?` toggles the shortcuts overlay from anywhere but a text field.
		if (e.key === '?' && !isTypingTarget(e.target)) {
			shortcutsOpen = !shortcutsOpen;
			e.preventDefault();
			return;
		}
		// Never hijack typing; let an open menu or overlay own the keyboard.
		if (isTypingTarget(e.target) || shortcutsOpen || labelsOpen) return;

		// Navigation changes the local selection.
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
		outbox={outbox.data}
		blocked={blocked.data ?? new Set()}
		labels={labelList}
		accounts={accountsQuery.data ?? []}
		{selectedAccount}
		onSelectAccount={(account) => {
			selectedAccount = account;
			selectedId = null;
			labelsOpen = false;
		}}
		onSignIn={connectAccount}
		reconciling={accountSyncs.current > 0}
		onRetry={() => {
			if (selectedAccount) reconcile.mutate(selectedAccount);
		}}
		onConnectAnother={connectAccount}
		onRemoveAccount={() => {
			const account = (accountsQuery.data ?? []).find(
				(candidate) => candidate.sub === selectedAccount,
			);
			if (account) removing = { sub: account.sub, email: account.email };
		}}
	/>

	<div class="flex gap-2 border-b p-2" aria-label="Mail views">
		<Button
			variant={view === 'mail' ? 'secondary' : 'ghost'}
			aria-pressed={view === 'mail'}
			onclick={() => (view = 'mail')}>Mailbox</Button
		>
		<Button
			variant={view === 'queries' ? 'secondary' : 'ghost'}
			aria-pressed={view === 'queries'}
			onclick={() => (view = 'queries')}>Saved queries</Button
		>
	</div>
	<div hidden={view !== 'queries'} class="min-h-0 flex-1 overflow-auto">
		<SavedQueries data={app.personal} account={selectedAccount} />
	</div>
	<div
		hidden={view !== 'mail'}
		class="min-h-0 flex-1 flex-col"
		class:flex={view === 'mail'}
	>
		{#if accountsQuery.error}<p role="alert" class="p-4 text-destructive">
				{accountsQuery.error.message}
			</p>{/if}
		{#if (accountsQuery.data ?? []).length === 0 || connecting}
			<ConnectPanel
				loading={accountsQuery.isPending}
				another={connecting}
				onConnected={(sub) => {
					connecting = false;
					queryClient.invalidateQueries({ queryKey: ['accounts'] });
					if (sub === null) return;
					// Connecting is opening, so it reconciles like an open does. It has
					// to: signing in again is the answer to a `signin` failure sitting in
					// the durable outbox, and only a pass replaces that row. Without this
					// the panel would keep offering Sign in to a person who just did.
					opened.add(sub);
					reconcile.mutate(sub);
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

<Dialog.Root
	open={shortcutsOpen}
	onOpenChange={(open) => (shortcutsOpen = open)}
>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
			<Dialog.Description
				>Triage without leaving the keyboard.</Dialog.Description
			>
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
