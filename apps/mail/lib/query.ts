/** Compile Gmail search terms into bound SQL over effective labels. */
export function parseQuery(query: string) {
	const params: (string | number)[] = [];
	const clauses: string[] = [];
	let includeHidden = false;
	const like = (columns: string[], value: string) => {
		const escaped = `%${value.replace(/[\\%_]/g, '\\$&')}%`;
		params.push(...columns.map(() => escaped));
		return `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\' COLLATE NOCASE`).join(' OR ')})`;
	};
	const label = (value: string) => {
		params.push(value, value);
		return `EXISTS(SELECT 1 FROM effective_labels e LEFT JOIN labels l ON l.id=e.label_id WHERE e.message_id=m.id AND (e.label_id=? COLLATE NOCASE OR l.name=? COLLATE NOCASE))`;
	};
	for (const token of query.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
		const negative = token.startsWith('-');
		const term = (negative ? token.slice(1) : token).replaceAll('"', '');
		const colon = term.indexOf(':');
		const operator = colon < 0 ? '' : term.slice(0, colon).toLowerCase();
		const value = term.slice(colon + 1);
		let clause: string | undefined;
		switch (operator) {
			case 'from':
				clause = like(['m.from_name', 'm.from_address'], value);
				break;
			case 'to':
				clause = like(['m.to_text'], value);
				break;
			case 'subject':
				clause = like(['m.subject'], value);
				break;
			case 'label':
				if (/^(trash|spam)$/i.test(value)) includeHidden = true;
				clause = label(value);
				break;
			case 'in':
				if (/^(trash|spam|anywhere)$/i.test(value)) includeHidden = true;
				if (value.toLowerCase() === 'anywhere') clause = '1';
				else if (/^(inbox|trash|spam)$/i.test(value)) clause = label(value);
				break;
			case 'is':
				if (value.toLowerCase() === 'pending')
					clause =
						'EXISTS(SELECT 1 FROM intent.label_intents i WHERE i.message_id=m.id)';
				else if (value.toLowerCase() === 'read')
					clause = `NOT (${label('UNREAD')})`;
				else if (/^(unread|starred|important)$/i.test(value))
					clause = label(value);
				break;
			case 'after':
			case 'before': {
				if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value))
					throw new Error(`Invalid search date "${value}"`);
				const date = Date.parse(`${value.replaceAll('/', '-')}T00:00:00Z`);
				if (!Number.isFinite(date))
					throw new Error(`Invalid search date "${value}"`);
				params.push(date);
				clause = `m.internal_date ${operator === 'after' ? '>' : '<'} ?`;
				break;
			}
		}
		clause ??= like(
			[
				'm.subject',
				'm.from_name',
				'm.from_address',
				'm.to_text',
				'm.snippet',
				'm.body',
			],
			term,
		);
		clauses.push(negative ? `NOT (${clause})` : clause);
	}
	if (!includeHidden)
		clauses.push(
			"NOT EXISTS(SELECT 1 FROM effective_labels hidden WHERE hidden.message_id=m.id AND hidden.label_id IN ('TRASH','SPAM'))",
		);
	return { where: clauses.length ? clauses.join(' AND ') : '1', params };
}
