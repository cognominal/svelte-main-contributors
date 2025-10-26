<script lang="ts">
	import { line, curveMonotoneX } from 'd3-shape';
	import { scaleLinear, scalePoint } from 'd3-scale';
	import type { ContributorSeries } from '$lib/types';

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

	export let series: ContributorSeries[] = [];
	export let periods: Array<{ label: string; start: string; end: string }> = [];
	export let interval: 'year' | 'month' = 'year';
	export let width = 960;
	export let height = 540;
	export let loading = false;

	const margin = { top: 56, right: 240, bottom: 56, left: 80 };

	function formatTick(label: string): string {
		if (interval === 'month') {
			const [year, month] = label.split('-').map(Number);
			if (!Number.isNaN(year) && !Number.isNaN(month)) {
				const date = new Date(Date.UTC(year, month - 1, 1));
				return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
			}
		}
		return label;
	}

	$: hasData = series.length > 0 && periods.length > 0;

	$: periodLabels = hasData ? periods.map((period) => period.label) : [];

	$: filteredSeries = series.filter((item) => item.values.some((value) => value.commits > 0));

	$: maxCommits =
		filteredSeries.length > 0
			? Math.max(
					1,
					...filteredSeries.map((item) =>
						item.values.reduce((highest, value) => Math.max(highest, value.commits), 0)
					)
				)
			: 1;

	$: chartWidth = width - margin.left - margin.right;
	$: chartHeight = height - margin.top - margin.bottom;

	$: xScale = scalePoint<string>()
		.domain(periodLabels)
		.range([margin.left, margin.left + chartWidth])
		.padding(0.5);

	$: yScale = scaleLinear()
		.domain([0, maxCommits])
		.nice()
		.range([margin.top + chartHeight, margin.top]);

	$: lineGenerator = line<{ label: string; commits: number }>()
		.curve(curveMonotoneX)
		.defined((d) => Number.isFinite(d.commits) && Number.isFinite(xScale(d.label) ?? Number.NaN))
		.x((d) => xScale(d.label) ?? margin.left)
		.y((d) => yScale(d.commits));

	$: chartSeries = filteredSeries.map((item, index) => {
		const color = PALETTE[index % PALETTE.length];
		const valueByLabel = new Map(item.values.map((value) => [value.label, value.commits]));
		const values = periodLabels.map((label) => ({
			label,
			commits: valueByLabel.get(label) ?? 0
		}));

		return {
			name: item.name,
			total: item.total,
			color,
			path: lineGenerator(values) ?? '',
			points: values.map((value) => ({
				...value,
				x: xScale(value.label) ?? margin.left,
				y: yScale(value.commits)
			}))
		};
	});

	$: xTicks = (() => {
		if (periodLabels.length <= 12) {
			return periodLabels;
		}

		const step = Math.ceil(periodLabels.length / 12);
		return periodLabels.filter((_, index) => index % step === 0);
	})();

	$: yTicks = yScale.ticks(6);
</script>

{#if loading}
	<div class="placeholder">
		<p>Fetching commit history…</p>
	</div>
{:else if !hasData}
	<div class="placeholder">
		<p>Enter a repository to see the top contributors over time.</p>
	</div>
{:else if filteredSeries.length === 0}
	<div class="placeholder">
		<p>No contributors found for the selected filters.</p>
	</div>
{:else}
	<svg {width} {height} role="img" aria-label={`Contributor trends per ${interval} line chart`}>
		<rect class="chart-bg" x={margin.left} y={margin.top} width={chartWidth} height={chartHeight} />

		<g class="axis axis--x">
			{#each xTicks as tick}
				{@const x = xScale(tick) ?? margin.left}
				<line x1={x} x2={x} y1={margin.top + chartHeight} y2={margin.top + chartHeight + 6} />
				<text x={x} y={margin.top + chartHeight + 20} text-anchor="middle">{formatTick(tick)}</text>
			{/each}
			<line
				x1={margin.left}
				x2={margin.left + chartWidth}
				y1={margin.top + chartHeight}
				y2={margin.top + chartHeight}
			/>
		</g>

		<g class="axis axis--y">
			{#each yTicks as commits}
				{@const y = yScale(commits)}
				<line x1={margin.left - 6} x2={margin.left} y1={y} y2={y} />
				<line x1={margin.left} x2={margin.left + chartWidth} y1={y} y2={y} class="grid" />
				<text x={margin.left - 12} y={y + 4} text-anchor="end">{commits}</text>
			{/each}
			<line x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + chartHeight} />
		</g>

		{#each chartSeries as item}
			<g class="series">
				<path d={item.path} style={`stroke: ${item.color}`} />
				{#each item.points as point}
					{#if point.commits > 0}
						<circle cx={point.x} cy={point.y} r="3" style={`fill: ${item.color}`} />
					{/if}
				{/each}
			</g>
		{/each}

		<text
			x={margin.left + chartWidth / 2}
			y={height - 12}
			text-anchor="middle"
			class="axis-label"
		>
			{interval === 'year' ? 'Year' : 'Month'}
		</text>
		<text
			transform={`translate(24 ${margin.top + chartHeight / 2}) rotate(-90)`}
			text-anchor="middle"
			class="axis-label"
		>
			Commits
		</text>

		<g class="legend">
			{#each chartSeries as item, index}
				<g transform={`translate(${margin.left + chartWidth + 24} ${margin.top + index * 26})`}>
					<rect width="16" height="16" style={`fill: ${item.color}`} />
					<text x="22" y="12">{item.name} ({item.total})</text>
				</g>
			{/each}
		</g>
	</svg>
{/if}

<style>
	svg {
		display: block;
		width: 100%;
		max-width: 100%;
	}

	.chart-bg {
		fill: var(--chart-bg, rgba(0, 0, 0, 0.03));
	}

	.axis line {
		stroke: var(--axis-stroke, #444);
		stroke-width: 1;
	}

	.axis text {
		fill: #333;
		font-family: var(--font-body, system-ui, sans-serif);
		font-size: 12px;
	}

	.axis .grid {
		stroke: rgba(0, 0, 0, 0.06);
	}

	.series path {
		fill: none;
		stroke-width: 2;
	}

	.series circle {
		stroke: #fff;
		stroke-width: 1;
	}

	.axis-label {
		fill: #444;
		font-family: var(--font-body, system-ui, sans-serif);
		font-size: 12px;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.legend text {
		fill: #333;
		font-family: var(--font-body, system-ui, sans-serif);
		font-size: 13px;
	}

	.placeholder {
		display: grid;
		align-content: center;
		justify-items: center;
		min-height: 320px;
		border: 1px dashed rgba(0, 0, 0, 0.1);
		border-radius: 12px;
		background: rgba(0, 0, 0, 0.015);
		padding: 2rem;
		text-align: center;
		color: #555;
		font-family: var(--font-body, system-ui, sans-serif);
	}
</style>
