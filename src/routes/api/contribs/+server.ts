import { json } from '@sveltejs/kit';
import { collectContributionSummary } from '$lib/server/gitStats';
import type { RepoContributionSummary } from '$lib/types';
import type { RequestHandler } from './$types';

interface RequestPayload {
	owner?: string;
	repo?: string;
	limit?: number;
}

function serializeSummary(summary: RepoContributionSummary) {
	const { slug, interval, startDate, endDate, periods, series } = summary;
	return { slug, interval, startDate, endDate, periods, series };
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as RequestPayload;
	const owner = body.owner?.trim();
	const repo = body.repo?.trim();
	const limit = Number(body.limit ?? 5);

	if (!owner || !repo) {
		return json({ error: 'Both owner and repository are required.' }, { status: 400 });
	}

	if (!Number.isFinite(limit) || limit <= 0) {
		return json({ error: 'The contributor limit must be a positive integer.' }, { status: 400 });
	}

	const slug = `${owner}/${repo}`;

	try {
		const summary = await collectContributionSummary(slug, limit);
		return json(serializeSummary(summary));
	} catch (error) {
		return json({ error: (error as Error).message }, { status: 500 });
	}
};
