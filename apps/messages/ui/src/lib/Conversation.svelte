<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { Spinner } from '@epicenter/ui/spinner';
	import { toast } from '@epicenter/ui/sonner';
	import { tick } from 'svelte';
	import {
		app,
		list,
		messageOf,
		thrownName,
		watch,
		type Conversation,
	} from './messages.svelte.js';
	let { chat }: { chat: string } = $props();
	let conversation = $state.raw<Conversation>();
	let text = $state('');
	let saved = $state('');
	let saving = $state(false);
	let sending = $state(false);
	let resolving = $state(false);
	let failed = $state(false);
	let conflict = $state(false);
	let problem = $state('');
	let loaded = false;
	let revision = 0;
	let reads = 0;
	let messagesPane = $state<HTMLDivElement>();
	let messageCount = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<boolean> | undefined;
	const dirty = $derived(text !== saved);
	const blocked = $derived(
		sending ||
			conflict ||
			text.trim() === '' ||
			conversation?.send?.state === 'sending' ||
			conversation?.send?.needsCheck ||
			!!conversation?.sendProblems?.length,
	);
	function cancel() {
		clearTimeout(timer);
		timer = undefined;
	}
	async function refresh(useTheirs = false) {
		const before = revision;
		const request = ++reads;
		try {
			const next = await app.read({ chat });
			if (request !== reads) return;
			const scrollToNewest = !loaded || next.messages.length > messageCount;
			messageCount = next.messages.length;
			conversation = next;
			problem = '';
			if (before === revision && (useTheirs || (!dirty && !saving && !sending))) {
				text = next.draft;
				saved = next.draft;
				failed = false;
				conflict = false;
			}
			loaded = true;
			if (scrollToNewest) {
				await tick();
				if (messagesPane && request === reads)
					messagesPane.scrollTop = messagesPane.scrollHeight;
			}
		} catch (error) {
			problem = messageOf(error);
		}
	}
	function save(force = false): Promise<boolean> {
		cancel();
		if (pending)
			return pending.then((ok) => (ok && text !== saved ? save(force) : ok));
		if (!loaded || (!force && conflict)) return Promise.resolve(false);
		if (!dirty && !force) return Promise.resolve(true);
		const typed = text;
		const previous = saved;
		saving = true;
		revision++;
		pending = (async () => {
			try {
				const result = await app.draft({
					chat,
					text: typed,
					...(force ? {} : { previous }),
				});
				saved = result.draft;
				failed = false;
				conflict = false;
				void list.refresh();
				return true;
			} catch (error) {
				failed = true;
				if (thrownName(error) === 'Changed') {
					conflict = true;
					toast('This draft changed in another window', {
						action: {
							label: 'Keep mine',
							onClick: () => {
								void save(true);
							},
						},
						cancel: {
							label: 'Use theirs',
							onClick: () => {
								void refresh(true);
							},
						},
					});
				} else
					toast.error('Could not save the draft', {
						description: messageOf(error),
					});
				return false;
			} finally {
				saving = false;
				pending = undefined;
			}
		})();
		return pending;
	}
	function input() {
		revision++;
		failed = false;
		cancel();
		timer = setTimeout(() => {
			void save();
		}, 800);
	}
	async function send() {
		if (
			sending ||
			conflict ||
			conversation?.send?.state === 'sending' ||
			conversation?.send?.needsCheck ||
			conversation?.sendProblems?.length ||
			text.trim() === ''
		)
			return;
		cancel();
		sending = true;
		revision++;
		try {
			if (!(await save())) return;
			const sendingText = text;
			const result = await app.send({ chat, text: sendingText });
			text = '';
			saved = '';
			failed = false;
			if (result.outcome === 'unconfirmed')
				toast.error('Beeper did not confirm your message', {
					description:
						"Check the conversation, then choose It was sent or It wasn't sent.",
				});
		} catch (error) {
			toast(messageOf(error));
		} finally {
			revision++;
			sending = false;
			await refresh();
			void list.refresh();
		}
	}
	async function resolve(outcome: 'sent' | 'not-sent') {
		const send = conversation?.send;
		if (!send || resolving) return;
		resolving = true;
		revision++;
		try {
			const result = await app.resolve({ chat, attempt: send.attempt, outcome });
			if (text === '') {
				text = result.draft;
				saved = result.draft;
			}
			await refresh();
			void list.refresh();
		} catch (error) {
			toast.error(messageOf(error));
		} finally {
			resolving = false;
		}
	}
	function keydown(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey)) return;
		if (event.key.toLowerCase() === 's') {
			event.preventDefault();
			void save();
		}
	}
	function composerKeydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
			event.preventDefault();
			void send();
		}
	}
	$effect(() => watch(() => refresh(), 5_000));
	$effect(() => {
		const leave = () => {
			if (dirty) void save();
		};
		const hidden = () => {
			if (document.visibilityState === 'hidden') leave();
		};
		window.addEventListener('pagehide', leave);
		document.addEventListener('visibilitychange', hidden);
		return () => {
			cancel();
			leave();
			window.removeEventListener('pagehide', leave);
			document.removeEventListener('visibilitychange', hidden);
		};
	});
</script>

<svelte:window onkeydown={keydown} />

<div class="flex h-full min-h-0 flex-col">
	{#if problem}
		<div role="alert" class="space-y-2 p-4">
			<p>{problem}</p>
			<Button variant="outline" onclick={() => refresh()}>Try again</Button>
		</div>
	{/if}

	{#if !conversation}
		<div class="p-8" role="status" aria-label="Loading conversation">
			<Spinner />
		</div>
	{:else}
		<header class="border-b p-4">
			<a href="#/" class="mb-2 block text-sm text-muted-foreground md:hidden">
				Back to conversations
			</a>
			<h1 class="font-semibold">{conversation.title}</h1>
			<p class="text-xs text-muted-foreground">{conversation.network}</p>
			{#if conversation.note}
				<p class="mt-2 text-sm text-muted-foreground">{conversation.note}</p>
			{/if}
			{#if conversation.sendProblems?.length}
				<div class="mt-2 text-sm text-destructive" role="note">
					{#each conversation.sendProblems as issue}
						<p>{issue}</p>
					{/each}
					<p>Repair the send record before sending another message.</p>
				</div>
			{/if}
		</header>

		<div
			bind:this={messagesPane}
			class="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
			aria-label="Messages"
		>
			{#each conversation.messages as message (message.id)}
				<article class="flex flex-col {message.mine ? 'items-end' : 'items-start'}">
					<div
						class="max-w-[85%] rounded-xl px-4 py-3 {message.mine
							? 'bg-primary text-primary-foreground'
							: 'bg-muted'}"
					>
						<p class="mb-1 text-xs opacity-70">{message.from}</p>
						<p class="whitespace-pre-wrap">{message.text}</p>
					</div>
					<time datetime={message.at} class="mt-1 text-xs text-muted-foreground">
						{new Date(message.at).toLocaleString()}
					</time>
				</article>
			{/each}
		</div>

		{#if conversation.send?.needsCheck}
			<section class="mx-4 mb-3 rounded-lg border p-4" aria-label="Check send">
				<h2 class="font-semibold">Your message may not have been sent</h2>
				<blockquote class="my-2 whitespace-pre-wrap border-l-2 pl-3">
					{conversation.send.text}
				</blockquote>
				<p class="text-xs text-muted-foreground">
					{new Date(conversation.send.at).toLocaleString()} · {conversation.send.error}
				</p>
				<p class="my-3 text-sm">
					Look for it in the conversation above. Messages will not send it again on its own.
				</p>
				<div class="flex gap-2">
					<Button disabled={resolving} onclick={() => resolve('sent')}>It was sent</Button>
					<Button variant="outline" disabled={resolving} onclick={() => resolve('not-sent')}>
						It wasn't sent
					</Button>
				</div>
			</section>
		{:else if conversation.send?.state === 'sending'}
			<p role="status" class="px-4 py-2">Sending…</p>
		{/if}

		<div class="border-t p-4">
			<Textarea
				aria-label="Reply"
				placeholder="Write a reply"
				bind:value={text}
				oninput={input}
				onblur={() => {
					void save();
				}}
				onkeydown={composerKeydown}
				disabled={sending}
				class="min-h-24 resize-none"
			/>
			<div class="mt-3 flex items-center gap-3">
				<p class="mr-auto text-xs text-muted-foreground" role="status">
					{saving ? 'Saving…' : failed || dirty ? 'Not saved' : 'Saved'}
				</p>
				<Button variant="outline" disabled={saving || sending} onclick={() => save()}>
					{failed ? 'Retry save' : 'Save'}
				</Button>
				<Button disabled={blocked} onclick={send}>{sending ? 'Sending…' : 'Send'}</Button>
			</div>
		</div>
	{/if}
</div>
