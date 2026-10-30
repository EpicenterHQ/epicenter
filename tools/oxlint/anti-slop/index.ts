import { eslintCompatPlugin } from '@oxlint/plugins';
import { noChainedTypeAssertionsRule } from './rules/no-chained-type-assertions.ts';
import { noKnownValueWideningRule } from './rules/no-known-value-widening.ts';
import { noWidenThenAssertRule } from './rules/no-widen-then-assert.ts';
import { requireSafetyCommentForTypeAssertionRule } from './rules/require-safety-comment-for-type-assertion.ts';

export default eslintCompatPlugin({
	meta: { name: 'anti-slop' },
	rules: {
		'no-chained-type-assertions': noChainedTypeAssertionsRule,
		'no-known-value-widening': noKnownValueWideningRule,
		'no-widen-then-assert': noWidenThenAssertRule,
		'require-safety-comment-for-type-assertion':
			requireSafetyCommentForTypeAssertionRule,
	},
});
