import { createPageLifetime as create } from './page-lifetime.svelte.js';

type Options = Parameters<typeof create>[0];
/** Plain lifecycle assertions; browser smoke verifies compiled rune updates and rendering. */
export function createPageLifetime(
	options: Pick<Options, 'opening'> & Partial<Options>,
) {
	Reflect.set(
		globalThis,
		'$state',
		Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
	);
	return create({
		auth: undefined,
		account: undefined,
		preflight: async () => {},
		stopUi: async () => {},
		...options,
	});
}
