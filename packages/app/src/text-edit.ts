import { Ok } from 'wellcrafted/result';
import { ActionError } from './errors.ts';

/** `body` with the passage `old` replaced by `replacement`; returns `Changed` unless `old` is there exactly once, or empty for an empty body. */
export function edited(
	path: string,
	body: string,
	old: string,
	replacement: string,
) {
	if (old === '') {
		if (body !== '') return ActionError.Changed({ path, why: 'empty' });
		return Ok(replacement);
	}
	const at = body.indexOf(old);
	if (at < 0) return ActionError.Changed({ path, why: 'quote' });
	if (body.indexOf(old, at + 1) >= 0)
		return ActionError.Changed({ path, why: 'twice' });
	return Ok(body.slice(0, at) + replacement + body.slice(at + old.length));
}
