/** Acceptance-only access to the mounted owner; production builds have no hook. */
export function observeBoot() {
	return {
		name: 'observe-mounted-app-boot',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('/boot-screens/app-boot.svelte')) return;
			return code.replace(
				'const status = fromSubscription',
				'Reflect.set(globalThis, "observedBoot", { opening, departure, account });\n\tconst status = fromSubscription',
			);
		},
	};
}
