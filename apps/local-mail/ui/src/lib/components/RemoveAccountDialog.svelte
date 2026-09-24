<script lang="ts">
	/**
	 * Removing one account, and the one question that decides what it costs.
	 *
	 * A person has one intention, so there is one verb (ADR-0320). What varies
	 * is whether Gmail has been told about the triage recorded here, and that is
	 * asked at the moment it matters rather than encoded in two verb names.
	 *
	 * There is no undo. Removal destroys a refresh token, and an undo that
	 * silently means "go through Google consent again" is a reconnection wearing
	 * another verb's name.
	 */
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import { relativeTime } from '$lib/format';
	import { mail } from '$lib/mail';

	let {
		account,
		onClose,
		onRemoved,
	}: {
		/** The account being removed, or nothing when the dialog is closed. */
		account: { sub: string; email: string } | null;
		onClose: () => void;
		onRemoved: () => void;
	} = $props();

	/**
	 * What this dialog is asking right now.
	 *
	 * `owed` and `stalled` are the same question with different histories: the
	 * first is what a person is told before they choose, and the second is what
	 * is left when delivering could not finish. Both offer the same two answers,
	 * because those are the only two that exist.
	 */
	type Step =
		| { kind: 'reading' }
		| { kind: 'clear' }
		| { kind: 'owed'; assertions: number; oldestAssertedAt: string | null }
		| { kind: 'working'; label: string }
		| {
				kind: 'stalled';
				delivered: number;
				owed: number;
				/** Whether a delivery was tried, or the count simply moved under us. */
				attempted: boolean;
			}
		| { kind: 'failed'; message: string };

	let step = $state<Step>({ kind: 'reading' });

	// Re-read every time the dialog opens for an account: what is owed changes
	// while a person triages, and a stale count would offer the wrong choice.
	$effect(() => {
		const opened = account;
		if (opened === null) return;
		step = { kind: 'reading' };
		void (async () => {
			try {
				// The outbox, not a second count of its own: this dialog and the
				// status bar's panel describe the same work, and a person who has
				// seen "3 waiting" must not be told a different number here.
				const owed = await mail.outbox(opened.sub);
				if (account?.sub !== opened.sub) return;
				step =
					owed.waiting === 0
						? { kind: 'clear' }
						: {
								kind: 'owed',
								assertions: owed.waiting,
								oldestAssertedAt: owed.oldestAssertedAt,
							};
			} catch (error) {
				if (account?.sub !== opened.sub) return;
				step = { kind: 'failed', message: messageOf(error) };
			}
		})();
	});

	function messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/**
	 * Remove, and report what is still owed rather than deleting it anyway.
	 *
	 * `owed` is what this attempt believed was outstanding, so the stalled state
	 * can say how much of it landed. Nothing was attempted on the plain path, so
	 * it passes zero and the copy says so.
	 */
	async function remove(sub: string, owed = 0): Promise<void> {
		const outcome = await mail.remove(sub);
		if (outcome.removed) {
			onRemoved();
			onClose();
			return;
		}
		step = {
			kind: 'stalled',
			// Never negative: a person triaging in another window can leave more
			// owed than this attempt set out to deliver.
			delivered: Math.max(owed - outcome.pending, 0),
			owed: outcome.pending,
			attempted: owed > 0,
		};
	}

	async function deliverThenRemove(sub: string, owed: number): Promise<void> {
		step = { kind: 'working', label: 'Delivering to Gmail' };
		try {
			// Resolves when the pass has finished, including one already running for
			// this account, so what is read back below is the state after a real
			// delivery rather than beside one still in flight.
			await mail.reconcile(sub);
			const left = await mail.outbox(sub);
			if (left.waiting > 0) {
				// Nothing has been deleted. A delivery that cannot finish is a
				// removal that did not happen, so the account stands as it was.
				step = {
					kind: 'stalled',
					delivered: Math.max(owed - left.waiting, 0),
					owed: left.waiting,
					attempted: true,
				};
				return;
			}
			if (!open(sub)) return;
			await remove(sub, owed);
		} catch (error) {
			step = { kind: 'failed', message: messageOf(error) };
		}
	}

	async function discardThenRemove(sub: string, owed: number): Promise<void> {
		step = { kind: 'working', label: 'Removing' };
		try {
			await mail.discard(sub);
			await remove(sub, owed);
		} catch (error) {
			step = { kind: 'failed', message: messageOf(error) };
		}
	}

	/** Whether this dialog is still the one that asked, and still about `sub`. */
	function open(sub: string): boolean {
		return account?.sub === sub;
	}

	/** The plain path, which can refuse for every reason the others can. */
	async function confirmRemove(sub: string): Promise<void> {
		step = { kind: 'working', label: 'Removing' };
		try {
			await remove(sub);
		} catch (error) {
			step = { kind: 'failed', message: messageOf(error) };
		}
	}
</script>

<Dialog.Root
	open={account !== null}
	onOpenChange={(shown) => {
		// A removal underway is not dismissible: closing here would leave the
		// account removed seconds later with nobody looking at it.
		if (!shown && step.kind !== 'working') onClose();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		{#if account !== null}
			<Dialog.Header>
				<Dialog.Title>
					{step.kind === 'stalled'
						? "Couldn't finish delivering"
						: `Remove ${account.email}?`}
				</Dialog.Title>
				<Dialog.Description>
					{#if step.kind === 'clear'}
						Removing deletes this device's copy of the mail. Gmail is untouched.
					{:else if step.kind === 'owed'}
						Gmail hasn't been told about {step.assertions}
						{step.assertions === 1 ? 'change' : 'changes'} you made here.
						{#if step.oldestAssertedAt}
							The oldest has been waiting {relativeTime(step.oldestAssertedAt)}.
						{/if}
					{:else if step.kind === 'stalled'}
						{#if step.attempted}
							{step.delivered} reached Gmail.
						{/if}
						{step.owed}
						{step.owed === 1 ? 'change is' : 'changes are'} still waiting, and
						nothing has been removed.
					{:else if step.kind === 'failed'}
						{step.message}
					{:else}
						Checking what Gmail hasn't been told about yet.
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			<Dialog.Footer>
				{#if step.kind === 'working'}
					<span
						class="flex items-center gap-2 text-sm text-muted-foreground"
					>
						<Spinner class="size-4" />
						{step.label}
					</span>
				{:else if step.kind === 'clear'}
					<Button variant="ghost" onclick={onClose}>Cancel</Button>
					<Button
						variant="destructive"
						onclick={() => confirmRemove(account.sub)}
					>
						Remove
					</Button>
				{:else if step.kind === 'owed'}
					{@const owed = step.assertions}
					<Button variant="ghost" onclick={onClose}>Cancel</Button>
					<Button
						variant="destructive"
						onclick={() => discardThenRemove(account.sub, owed)}
					>
						Discard {owed} and remove
					</Button>
					<Button onclick={() => deliverThenRemove(account.sub, owed)}>
						Deliver them, then remove
					</Button>
				{:else if step.kind === 'stalled'}
					{@const owed = step.owed}
					<Button
						variant="destructive"
						onclick={() => discardThenRemove(account.sub, owed)}
					>
						Discard {owed} and remove
					</Button>
					<Button onclick={onClose}>Keep the account, try again later</Button>
				{:else if step.kind === 'failed'}
					<Button onclick={onClose}>Close</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
