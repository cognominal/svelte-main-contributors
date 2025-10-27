import { json } from '@sveltejs/kit';
import { collectContributionSummary, type ProgressEvent } from '$lib/server/gitStats';
import type { RepoContributionSummary } from '$lib/types';
import type { RequestHandler } from './$types';

interface RequestPayload {
	owner?: string;
	repo?: string;
	limit?: number;
	excludeBots?: boolean;
	topStarred?: boolean;
}

function serializeSummary(summary: RepoContributionSummary) {
	const { slug, interval, startDate, endDate, periods, series } = summary;
	const sanitizedPeriods = periods.map((period) => ({
		...period,
		contributors: period.contributors.map(({ email: _email, ...rest }) => rest)
	}));
	return { slug, interval, startDate, endDate, periods: sanitizedPeriods, series };
}

function filterBotContributors(summary: RepoContributionSummary): RepoContributionSummary {
	const isBot = (name: string) => name.toLowerCase().includes('bot');

	const periods = summary.periods.map((period) => ({
		...period,
		contributors: period.contributors.filter((contributor) => !isBot(contributor.author))
	}));

	const series = summary.series.filter((item) => !isBot(item.name));

	return {
		...summary,
		periods,
		series
	};
}

interface RepoSummary {
	slug: string;
	description?: string;
}

async function fetchTopStarredRepositories(owner: string, count: number): Promise<RepoSummary[]> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json'
	};
	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	const profileResponse = await fetch(`https://api.github.com/users/${owner}`, { headers });
	if (profileResponse.status === 404) {
		throw new Error(`GitHub user "${owner}" was not found.`);
	}
	if (!profileResponse.ok) {
		const detail = await profileResponse.text();
		throw new Error(`Failed to validate user ${owner}: ${profileResponse.status} ${detail}`);
	}

	const searchResponse = await fetch(
		`https://api.github.com/search/repositories?q=user:${owner}&sort=stars&order=desc&per_page=${count}`,
		{ headers }
	);

	if (!searchResponse.ok) {
		const detail = await searchResponse.text();
		throw new Error(`Failed to fetch top repositories for ${owner}: ${searchResponse.status} ${detail}`);
	}

	const payload = (await searchResponse.json()) as {
		items?: Array<{ full_name?: string | null; description?: string | null }>;
	};

return (payload.items ?? [])
		.map((item): RepoSummary | null => {
			if (!item?.full_name) {
				return null;
			}

			return {
				slug: item.full_name,
				description: item.description ?? undefined
			};
		})
		.filter((value): value is RepoSummary => value !== null)
		.slice(0, count);
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as RequestPayload;
	const owner = body.owner?.trim();
	const repo = body.repo?.trim();
	const limit = Number(body.limit ?? 5);
	const excludeBots = body.excludeBots === true;
	const topStarred = body.topStarred === true;

	if (!Number.isFinite(limit) || limit <= 0) {
		return json({ error: 'The contributor limit must be a positive integer.' }, { status: 400 });
	}

	let manualSlug: string | null = null;
	if (!owner) {
		return json({ error: 'Owner is required.' }, { status: 400 });
	}
	if (!topStarred) {
		if (!repo) {
			return json({ error: 'Both owner and repository are required.' }, { status: 400 });
		}
		manualSlug = `${owner}/${repo}`;
	}

	try {
		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				let closed = false;

				const send = (payload: unknown) => {
					if (closed) {
						return;
					}
					controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
				};

				const close = () => {
					if (!closed) {
						closed = true;
						controller.close();
					}
				};

				const abortWith = (error: unknown) => {
					if (!closed) {
						closed = true;
						const reason = error instanceof Error ? error : new Error(String(error));
						controller.error(reason);
					}
				};

				const { signal } = request;
				if (signal.aborted) {
					abortWith(new Error('Request aborted'));
					return;
				}

				const handleProgress = (event: ProgressEvent) => {
					if (event.type === 'git') {
						send({
							type: 'git',
							command: event.command,
							stream: event.stream,
							text: event.text
						});
						return;
					}

					send({ type: 'status', message: event.message });
				};

				const abortListener = () => {
					abortWith(new Error('Request aborted'));
				};

					signal.addEventListener('abort', abortListener);

					(async () => {
						try {
	const repoSummaries = topStarred
		? await fetchTopStarredRepositories(owner!, 5)
		: manualSlug
			? [{ slug: manualSlug }]
			: [];

	const slugs = repoSummaries.map((entry) => entry.slug);

							if (slugs.length === 0) {
								send({ type: 'error', message: 'No repositories found to process.' });
								return;
							}

const collected: RepoContributionSummary[] = [];
							for (const [index, currentSlug] of slugs.entries()) {
								send({
									type: 'status',
									message: `Processing ${currentSlug} (${index + 1}/${slugs.length})`
								});

const summary = await collectContributionSummary(currentSlug, limit, {
									onProgress: handleProgress,
									signal
								});
								const finalSummary = excludeBots ? filterBotContributors(summary) : summary;
								collected[index] = finalSummary;
								send({
									type: 'partial',
									index,
									total: slugs.length,
									summary: serializeSummary(finalSummary),
									description: repoSummaries[index]?.description ?? null
								});
							}

							send({
								type: 'complete',
								summaries: collected.map((entry, idx) => ({
									...serializeSummary(entry),
									description: repoSummaries[idx]?.description ?? null
								}))
							});
						} catch (error) {
							if (!signal.aborted) {
								send({ type: 'error', message: (error as Error).message ?? 'Unknown error' });
							}
					} finally {
						signal.removeEventListener('abort', abortListener);
						close();
					}
				})().catch((error) => {
					signal.removeEventListener('abort', abortListener);
					abortWith(error);
				});
			}
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'application/x-ndjson',
				'Cache-Control': 'no-cache'
			}
		});
	} catch (error) {
		return json({ error: (error as Error).message }, { status: 500 });
	}
};
