import { redirect } from '@sveltejs/kit';

// `/<owner>` opens that owner's home: every owner's home repository is named `home`.
export function load({ params }) {
	redirect(307, `/${encodeURIComponent(params.owner)}/home`);
}
