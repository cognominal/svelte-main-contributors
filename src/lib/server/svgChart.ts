import type { RepoContributionSummary } from '$lib/types';

const PALETTE = [
	'#1f77b4',
	'#ff7f0e',
	'#2ca02c',
	'#d62728',
	'#9467bd',
	'#8c564b',
	'#e377c2',
	'#7f7f7f',
	'#bcbd22',
	'#17becf'
];

interface SvgOptions {
	width?: number;
	height?: number;
	title?: string;
}

function sanitizeTitle(slug: string): string {
	return slug.replace(/[<>"]/g, '');
}

function formatTick(label: string, interval: RepoContributionSummary['interval']): string {
	if (interval === 'month') {
		const [yearString, monthString] = label.split('-');
		const year = Number.parseInt(yearString, 10);
		const month = Number.parseInt(monthString, 10);
		if (!Number.isNaN(year) && !Number.isNaN(month)) {
			const date = new Date(Date.UTC(year, month - 1, 1));
			return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(date);
		}
	}

	return label;
}

export function renderContributionSvg(summary: RepoContributionSummary, options: SvgOptions = {}): string {
	const width = options.width ?? 960;
	const height = options.height ?? 540;
	const margin = { top: 48, right: 240, bottom: 56, left: 72 };

	const periods = summary.periods;
	const labels = periods.map((period) => period.label);
	if (labels.length === 0) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#111" />
  <text x="${width / 2}" y="${height / 2}" fill="#fff" font-family="sans-serif" font-size="24" text-anchor="middle">
    No commits found
  </text>
</svg>`;
	}

	const chartWidth = width - margin.left - margin.right;
	const chartHeight = height - margin.top - margin.bottom;

	const maxCommits = Math.max(
		1,
		...summary.series.map((series) => series.values.reduce((acc, value) => Math.max(acc, value.commits), 0))
	);

	const pointsPerSeries = summary.series.map((series) => {
		const valueByLabel = new Map(series.values.map((value) => [value.label, value.commits]));
		return labels.map((label, index) => {
			const commits = valueByLabel.get(label) ?? 0;
			const x =
				margin.left +
				(labels.length > 1 ? (chartWidth * index) / (labels.length - 1) : chartWidth / 2);
			const y =
				margin.top +
				chartHeight -
				chartHeight * (commits / maxCommits);

			return { x, y, label, commits };
		});
	});

	const axisLines = `
  <line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${
		margin.top + chartHeight
	}" stroke="#ccc" stroke-width="1" />
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${
		margin.top + chartHeight
	}" stroke="#ccc" stroke-width="1" />`;

	const yTicks = 5;
	const yTickElements = Array.from({ length: yTicks + 1 }, (_, index) => {
		const ratio = index / yTicks;
		const commits = Math.round(maxCommits * ratio);
		const y = margin.top + chartHeight - chartHeight * ratio;
		return `<line x1="${margin.left - 6}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#888" stroke-width="1" />
    <text x="${margin.left - 12}" y="${y + 4}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#555">${commits}</text>`;
	}).join('\n');

	const xTickElements = labels
		.map((label, index) => {
			const x =
				margin.left +
				(labels.length > 1 ? (chartWidth * index) / (labels.length - 1) : chartWidth / 2);
			return `<line x1="${x}" y1="${margin.top + chartHeight}" x2="${x}" y2="${
				margin.top + chartHeight + 6
			}" stroke="#888" stroke-width="1" />
    <text x="${x}" y="${margin.top + chartHeight + 22}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#555">${formatTick(label, summary.interval)}</text>`;
		})
		.join('\n');

	const linePaths = summary.series
		.map((series, seriesIndex) => {
			const color = PALETTE[seriesIndex % PALETTE.length];
			const points = pointsPerSeries[seriesIndex];
			if (!points || points.every((point) => point.commits === 0)) {
				return '';
			}

			const pathData = points
				.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
				.join(' ');

			const circles = points
				.filter((point) => point.commits > 0)
				.map(
					(point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(
						2
					)}" r="3" fill="${color}" />`
				)
				.join('\n');

			return `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2" />
${circles}`;
		})
		.filter(Boolean)
		.join('\n');

	const legendEntries = summary.series
		.map((series, index) => {
			const color = PALETTE[index % PALETTE.length];
			const legendX = margin.left + chartWidth + 24;
			const legendY = margin.top + index * 24;
			return `<rect x="${legendX}" y="${legendY - 12}" width="12" height="12" fill="${color}" />
  <text x="${legendX + 18}" y="${legendY - 2}" font-family="sans-serif" font-size="13" fill="#222">${series.name} (${series.total})</text>`;
		})
		.join('\n');

	const title = sanitizeTitle(options.title ?? `Top contributors for ${summary.slug}`);
	const axisLabel = summary.interval === 'month' ? 'Month' : 'Year';

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">
  <rect width="100%" height="100%" fill="#fff" />
  <text x="${margin.left}" y="${margin.top - 16}" font-family="sans-serif" font-size="20" font-weight="600" fill="#111">${title}</text>
  ${axisLines}
  ${yTickElements}
  ${xTickElements}
  ${linePaths}
  ${legendEntries}
  <text x="${margin.left + chartWidth / 2}" y="${height - 12}" font-family="sans-serif" font-size="12" fill="#555" text-anchor="middle">${axisLabel}</text>
  <text transform="translate(20 ${(margin.top + chartHeight / 2).toFixed(
		2
	)}) rotate(-90)" font-family="sans-serif" font-size="12" fill="#555" text-anchor="middle">Commits</text>
</svg>`;
}
