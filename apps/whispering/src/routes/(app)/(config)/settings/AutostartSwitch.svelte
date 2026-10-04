<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';
	import {
		createMutation,
		createQuery,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import { report } from '$lib/report';
	import type { Tauri } from '#platform/tauri';

	// The caller narrows `tauri` to non-null and passes just this namespace, so
	// nothing here re-checks for the platform. The OS login-item registry is the
	// source of truth; we read it rather than mirror it in a stored setting.
	let { autostart }: { autostart: Tauri['autostart'] } = $props();

	const queryClient = useQueryClient();
	const isEnabledQuery = createQuery(() => autostart.isEnabled.options);
	// The capability module carries no query client, so the mutation cannot
	// invalidate from `onSettled` itself; reuse the query's own key rather
	// than hand-mirroring it.
	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: autostart.isEnabled.options.queryKey,
		});
	const enableMutation = createMutation(() => ({
		...autostart.enable.options,
		onSettled: invalidate,
	}));
	const disableMutation = createMutation(() => ({
		...autostart.disable.options,
		onSettled: invalidate,
	}));
</script>

<Field.Field orientation="horizontal">
	<Field.Content>
		<Field.Label for="autostart">Launch on Startup</Field.Label>
		<Field.Description>
			Automatically open Epicenter when you log in
		</Field.Description>
	</Field.Content>
	<Switch
		id="autostart"
		checked={isEnabledQuery.data ?? false}
		onCheckedChange={(checked) => {
			if (checked) {
				enableMutation.mutate(undefined, {
					onError: (error) => report.error({ cause: error }),
				});
			} else {
				disableMutation.mutate(undefined, {
					onError: (error) => report.error({ cause: error }),
				});
			}
		}}
		disabled={isEnabledQuery.isPending ||
			enableMutation.isPending ||
			disableMutation.isPending}
	/>
</Field.Field>
