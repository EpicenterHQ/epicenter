<script lang="ts">
	import { AppBoot, CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { auth } from '#platform/auth';
	import { onMount, tick } from 'svelte';

	let mounted = $state.raw<{
		application: typeof import('$lib/application.js');
		Shell: typeof import('$lib/components/MailShell.svelte').default;
	}>();
	let shell =
		$state.raw<
			ReturnType<typeof import('$lib/components/MailShell.svelte').default>
		>();
	let error = $state('');
	let showing = $state(true);
	const queryClient = useQueryClient();

	onMount(() => {
		let stopped = false;
		void import('$lib/application.js')
			.then(async (application) => {
				if (stopped) {
					await application.departure.close();
					return;
				}
				application.departure.attachUi({
					async preflight() {
						await shell?.preflight();
					},
					async quiesce() {
						showing = false;
						await tick();
						await queryClient.cancelQueries();
						queryClient.clear();
					},
				});
				try {
					const { default: Shell } =
						await import('$lib/components/MailShell.svelte');
					if (stopped) {
						await application.departure.close();
						return;
					}
					mounted = { application, Shell };
				} catch (cause) {
					await application.departure.close();
					throw cause;
				}
			})
			.catch((cause) => {
				error =
					cause instanceof Error ? cause.message : 'Could not open Local Mail.';
			});
		return () => {
			stopped = true;
		};
	});
</script>

{#if error}
	<p role="alert" class="p-6">{error}</p>
{:else if mounted}
	<AppBoot
		{auth}
		departure={mounted.application.departure}
		hasApp={mounted.application.app !== null}
		appName="Local Mail"
		noun="saved queries and mail"
	>
		{#if mounted.application.app && showing}
			{#await mounted.application.app.ready}
				<Loading class="h-dvh" label="Opening Local Mail…" />
			{:then { error }}
				{#if error !== null}
					<CannotOpenScreen
						appName="Local Mail"
						noun="saved queries and mail"
						{error}
						retry={() => location.reload()}
					/>
				{:else}
					<mounted.Shell bind:this={shell} data={mounted.application.app} />
				{/if}
			{/await}
		{/if}
	</AppBoot>
{:else}
	<Loading class="h-dvh" label="Opening Local Mail…" />
{/if}
