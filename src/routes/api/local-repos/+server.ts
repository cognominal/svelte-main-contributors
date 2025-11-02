import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadOwnerMap } from '$lib/server/ownerMap';

export const GET: RequestHandler = async () => {
	const map = await loadOwnerMap();
	return json(map);
};
