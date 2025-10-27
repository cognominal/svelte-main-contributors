import { json } from '@sveltejs/kit';
import { collectContributionSummary, type ProgressEvent } from '$lib/server/gitStats';
import type { RepoContributionSummary } from '$lib/types';
import type { RequestHandler } from './$types';

interface RequestPayload {
	owner?: string;
	repo?: string;
	limit?: number;
	excludeBots?: boolean;
}

function serializeSummary(summary: RepoContributionSummary) {
	const { slug, interval, startDate, endDate, periods, series } = summary;
	return { slug, interval, startDate, endDate, periods, series };
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

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as RequestPayload;
	const owner = body.owner?.trim();
	const repo = body.repo?.trim();
	const limit = Number(body.limit ?? 5);
	const excludeBots = body.excludeBots !== false;

	if (!owner || !repo) {
		return json({ error: 'Both owner and repository are required.' }, { status: 400 });
	}

	if (!Number.isFinite(limit) || limit <= 0) {
		return json({ error: 'The contributor limit must be a positive integer.' }, { status: 400 });
	}

	const slug = `${owner}/${repo}`;

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
						const summary = await collectContributionSummary(slug, limit, {
							onProgress: handleProgress,
							signal
						});
						const finalSummary = excludeBots ? filterBotContributors(summary) : summary;
						send({ type: 'result', summary: serializeSummary(finalSummary) });
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
