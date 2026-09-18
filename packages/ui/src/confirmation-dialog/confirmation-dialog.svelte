<script module lang="ts">
	/**
	 * Options for opening a confirmation dialog.
	 */
	export type ConfirmationDialogOptions = {
		/** Title displayed at the top of the dialog */
		title: string;
		/** Description text shown below the title */
		description: string;
		/** Configuration for the confirm button */
		confirm?: {
			/** Text for the confirm button. Defaults to "Confirm" */
			text?: string;
			/** Variant for the confirm button. Defaults to "default" */
			variant?: 'default' | 'destructive';
		};
		/** Configuration for the cancel button */
		cancel?: {
			/** Text for the cancel button. Defaults to "Cancel" */
			text?: string;
		};
		/**
		 * Require user to type a specific phrase to confirm.
		 * The confirm button is disabled until the input matches.
		 */
		input?: {
			/** The exact text the user must type to confirm */
			confirmationText: string;
		};
		/**
		 * Called when the user confirms. Can be async, so the dialog will show
		 * a loading state and stay open until the promise resolves.
		 * Throw an error to keep the dialog open (e.g., on failure).
		 */
		onConfirm: () => void | Promise<unknown>;
		/** Called when the user cancels */
		onCancel?: () => void;
	};

	/**
	 * Creates a confirmation dialog state manager.
	 *
	 * Mount the `ConfirmationDialog` component once in your app layout,
	 * then call `confirmationDialog.open()` from anywhere to trigger it.
	 *
	 * @example
	 * ```ts
	 * // Basic usage
	 * confirmationDialog.open({
	 *   title: 'Delete item',
	 *   description: 'Are you sure you want to delete this item?',
	 *   confirm: { text: 'Delete', variant: 'destructive' },
	 *   onConfirm: async () => {
	 *     await deleteItem();
	 *   },
	 * });
	 *
	 * // With text confirmation (user must type "DELETE" to confirm)
	 * confirmationDialog.open({
	 *   title: 'Delete all data',
	 *   description: 'This will permanently delete all your data.',
	 *   input: { confirmationText: 'DELETE' },
	 *   confirm: { text: 'Delete All', variant: 'destructive' },
	 *   onConfirm: () => deleteAllData(),
	 * });
	 * ```
	 */
	function createConfirmationDialog() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let hasFailed = $state(false);
		let inputText = $state('');
		let options = $state.raw<ConfirmationDialogOptions | null>(null);

		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			get isPending() {
				return isPending;
			},
			get hasFailed() {
				return hasFailed;
			},
			get inputText() {
				return inputText;
			},
			set inputText(value) {
				inputText = value;
			},
			get options() {
				return options;
			},

			/**
			 * Opens the confirmation dialog with the given options.
			 */
			open(opts: ConfirmationDialogOptions) {
				// Every opening owns a distinct completion, even if opts is reused.
				options = { ...opts };
				isPending = false;
				hasFailed = false;
				inputText = '';
				isOpen = true;
			},

			/**
			 * Closes the dialog and resets state.
			 */
			close() {
				isOpen = false;
				isPending = false;
				hasFailed = false;
				inputText = '';
				options = null;
			},

			/**
			 * Returns true if the confirm button should be enabled.
			 * When input confirmation is required, checks if inputText matches.
			 */
			get canConfirm() {
				if (!options?.input) return true;
				return inputText === options.input.confirmationText;
			},

			/**
			 * Handles the confirm action. If onConfirm returns a promise,
			 * shows a loading state until it resolves.
			 */
			async confirm() {
				if (!isOpen || !options || isPending) return;
				if (options.input && inputText !== options.input.confirmationText)
					return;

				const current = options;
				isPending = true;
				hasFailed = false;
				try {
					await current.onConfirm();
					if (options === current) isOpen = false;
				} catch (error) {
					if (options === current) hasFailed = true;
					throw error;
				} finally {
					if (options === current) isPending = false;
				}
			},

			/**
			 * Handles the cancel action.
			 */
			cancel() {
				if (!isOpen || isPending) return;
				const current = options;
				current?.onCancel?.();
				if (options === current) isOpen = false;
			},
		};
	}

	export const confirmationDialog = createConfirmationDialog();
</script>

<script lang="ts">
	import * as AlertDialog from '../alert-dialog/index.js';
	import { Input } from '../input/index.js';
	import { Spinner } from '../spinner/index.js';
	import { cn } from '../utils.js';
</script>

<AlertDialog.Root bind:open={confirmationDialog.isOpen}>
	<AlertDialog.Content
		class="sm:max-w-xl"
		onEscapeKeydown={(event) => {
			event.preventDefault();
			confirmationDialog.cancel();
		}}
	>
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				// confirm owns inline failure feedback; callers may add domain detail.
				void confirmationDialog.confirm().catch(() => {});
			}}
			class="flex flex-col gap-4"
		>
			<AlertDialog.Header>
				<AlertDialog.Title
					>{confirmationDialog.options?.title}</AlertDialog.Title
				>
				<AlertDialog.Description>
					{confirmationDialog.options?.description}
				</AlertDialog.Description>
			</AlertDialog.Header>

			{#if confirmationDialog.options?.input}
				<Input
					bind:value={confirmationDialog.inputText}
					placeholder='Type "{confirmationDialog.options.input.confirmationText}" to confirm'
				/>
			{/if}

			{#if confirmationDialog.hasFailed}
				<p role="alert" class="text-sm text-destructive">
					Could not complete the action. Try again.
				</p>
			{/if}

			<AlertDialog.Footer>
				<AlertDialog.Cancel
					type="button"
					onclick={(event) => {
						event.preventDefault();
						confirmationDialog.cancel();
					}}
					onkeydown={(event) => {
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault();
						confirmationDialog.cancel();
					}}
					disabled={confirmationDialog.isPending}
				>
					{#snippet child({ props })}
						<button {...props} disabled={confirmationDialog.isPending}>
							{confirmationDialog.options?.cancel?.text ?? 'Cancel'}
						</button>
					{/snippet}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					type="submit"
					disabled={confirmationDialog.isPending ||
						!confirmationDialog.canConfirm}
					class={cn(
						confirmationDialog.options?.confirm?.variant === 'destructive' &&
							'bg-destructive hover:bg-destructive/90 text-white',
					)}
				>
					{#if confirmationDialog.isPending}
						<Spinner class="size-4" />
					{/if}
					{confirmationDialog.options?.confirm?.text ?? 'Confirm'}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
