/** JSON object source admission before a declaration writer can replace bytes. */
import { Err, Ok, type Result } from 'wellcrafted/result';

/** Parse JSON without discarding duplicate keys or rounding numeric values. */
export function parseJsonObject(
	text: string,
	options: { forLocalPolicy?: true } = {},
): Result<Record<string, unknown>, { reason: string }> {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== 'object' || value === null || Array.isArray(value))
			return Err({ reason: 'must be a JSON object' });
		// JSON.parse already established syntax. Walk its tokens to detect keys
		// before their earlier values disappear, including escaped spellings.
		let at = 0;
		const whitespace = () => {
			while (/\s/.test(text[at] ?? '') && at < text.length) at++;
		};
		const string = () => {
			const start = at++;
			while (at < text.length) {
				const char = text[at++];
				if (char === '\\') at++;
				else if (char === '"') break;
			}
			return JSON.parse(text.slice(start, at)) as string;
		};
		const visit = (): void => {
			whitespace();
			switch (text[at]) {
				case '{': {
					at++;
					whitespace();
					const keys = new Set<string>();
					while (text[at] !== '}') {
						const key = string();
						if (keys.has(key)) throw new Error(`duplicate JSON key '${key}'`);
						keys.add(key);
						whitespace();
						at++; // colon
						visit();
						whitespace();
						if (text[at] === ',') at++;
						whitespace();
					}
					at++;
					return;
				}
				case '[':
					at++;
					whitespace();
					while (text[at] !== ']') {
						visit();
						whitespace();
						if (text[at] === ',') at++;
						whitespace();
					}
					at++;
					return;
				case '"':
					string();
					return;
				default:
					const start = at;
					while (at < text.length && !/[\s,}\]]/.test(text[at] ?? '')) at++;
					const token = text.slice(start, at);
					// The protective local reader never serializes unrelated values.
					// All declaration replacement and table readers retain fidelity checks.
					if (!options.forLocalPolicy && /^-?\d/.test(token)) {
						const number = Number(token);
						if (
							!Number.isFinite(number) ||
							Object.is(number, -0) ||
							exactDecimal(token) !== exactDecimal(JSON.stringify(number))
						)
							throw new Error(
								`JSON number '${token}' cannot be preserved exactly`,
							);
					}
			}
		};
		visit();
		return Ok(value as Record<string, unknown>);
	} catch (cause) {
		return Err({
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

/** Decimal value independent of spelling, with no floating-point arithmetic. */
function exactDecimal(token: string): string {
	const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
	if (match === null) throw new Error(`Invalid JSON number '${token}'`);
	const fraction = match[3] ?? '';
	const coefficient = `${match[2]}${fraction}`.replace(/^0+/, '');
	if (coefficient === '') return '0';
	const digits = coefficient.replace(/0+$/, '');
	const exponent =
		BigInt(match[4] ?? '0') -
		BigInt(fraction.length) +
		BigInt(coefficient.length - digits.length);
	return `${match[1]}${digits}e${exponent}`;
}
