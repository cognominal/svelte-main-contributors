import type { PageLoad } from './$types';
import type { OwnerMap } from '$lib/types';

export const load: PageLoad = async ({ fetch }) => {
	try {
		const response = await fetch('/api/local-repos');
		if (!response.ok) {
			const empty: OwnerMap = {};
			return { ownerMap: empty };
		}
		const ownerMap = (await response.json()) as OwnerMap;
		return { ownerMap };
	} catch {
		const empty: OwnerMap = {};
		return { ownerMap: empty };
	}
};
