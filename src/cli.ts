#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectContributionSummary, type ProgressEvent } from './lib/server/gitStats';
import { renderContributionSvg } from './lib/server/svgChart';

function printUsage(): void {
	console.error('Usage: contribs <owner/repo> <contributors-per-year>');
	console.error('Example: contribs torvalds/linux 5');
}

function sanitizeFileName(slug: string, limit: number): string {
	return `${slug.replace(/[\\/]/g, '--')}--top-${limit}.svg`;
}

function handleProgress(event: ProgressEvent): void {
	if (event.type === 'status') {
		console.log(event.message);
		return;
	}

	const writer = event.stream === 'stderr' ? process.stderr : process.stdout;
	writer.write(event.text);
}

async function main(): Promise<void> {
	const [, , slug, limitArg] = process.argv;

	if (!slug) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const limit = Number.parseInt(limitArg ?? '', 10);
	if (!Number.isFinite(limit) || limit <= 0) {
		console.error('The second argument must be a positive integer.');
		printUsage();
		process.exitCode = 1;
		return;
	}

	try {
		console.log(`Preparing statistics for ${slug} (top ${limit} contributors per interval)...`);
		const summary = await collectContributionSummary(slug, limit, { onProgress: handleProgress });
		const intervalLabel = summary.interval === 'month' ? 'month' : 'year';
		const svg = renderContributionSvg(summary, {
			title: `Top ${limit} contributors per ${intervalLabel} for ${slug}`
		});

		const outputPath = join(process.cwd(), sanitizeFileName(slug, limit));
		await writeFile(outputPath, svg, 'utf-8');

		console.log(`Repository synced to: ${summary.repoPath}`);
		console.log(`Aggregation interval: ${intervalLabel}`);
		console.log(`SVG chart saved to: ${outputPath}`);
	} catch (error) {
		console.error((error as Error).message);
		process.exitCode = 1;
	}
}

void main();
