<script lang="ts">
	// The first thing a person sees with no account connected, and the only
	// place Local Mail asks for one.
	import { gmailSignInNotice } from '#platform/gmail-authorization';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import MailIcon from '@lucide/svelte/icons/mail';
	import { toast } from 'svelte-sonner';
	import { hasGmailIdentity } from '$lib/identity';
	import { mail } from '$lib/mail';

	let { loading, another = false, onConnected, onCancel }: {
		loading: boolean;
		/**
		 * Whether this is the person's first account or one more.
		 *
		 * The same flow either way, because connecting a second account is not a
		 * different act. What changes is that there is a mailbox to go back to.
		 */
		another?: boolean;
		/**
		 * Called when the flow finished, with the account's Google subject when
		 * one was connected and `null` when nothing was. The page re-reads the
		 * list either way, and reconciles the account it was handed: a credential
		 * is only proven by a pass, and re-connecting a signed-out account has to
		 * replace the failure its last pass wrote down.
		 */
		onConnected: (sub: string | null) => void;
		/** Leave without connecting. Only reachable when there is a mailbox behind this. */
		onCancel?: () => void;
	} = $props();

	let starting = $state(false);

	async function connect(): Promise<void> {
		starting = true;
		let connected: string | null = null;
		try {
			const request = await mail.beginConnect();
			// Both builds retain this document and return the consent callback.
			// The verifier and browser credentials stay with the open App.
			const callbackUrl = await mail.authorize(request);
			connected = (await mail.finishConnect(request, callbackUrl)).sub;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			starting = false;
			onConnected(connected);
		}
	}
</script>

<div class="grid min-h-0 flex-1 place-items-center p-8">
	{#if loading}
		<Loading label="Reading your connected accounts" />
	{:else}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><MailIcon /></Empty.Media>
				<Empty.Title>
					{another ? 'Connect another Gmail account' : 'Connect a Gmail account'}
				</Empty.Title>
				<Empty.Description>
					Local Mail keeps a copy of your mail on this machine and delivers your
					changes back to Gmail. {gmailSignInNotice}
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				{#if hasGmailIdentity()}
					<div class="flex items-center gap-2">
						<Button onclick={connect} disabled={starting}>
							{starting ? 'Waiting for Google' : 'Connect Gmail'}
						</Button>
						{#if another && onCancel}
							<Button variant="ghost" onclick={onCancel} disabled={starting}>
								Cancel
							</Button>
						{/if}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">
						This build has no Google OAuth client compiled in. Set
						<code>VITE_GMAIL_CLIENT_ID</code> and
						<code>VITE_GMAIL_CLIENT_SECRET</code> and build again.
					</p>
				{/if}
			</Empty.Content>
		</Empty.Root>
	{/if}
</div>
