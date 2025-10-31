<script lang="ts">
  import { line, curveMonotoneX } from "d3-shape";
  import { createEventDispatcher } from "svelte";
  import { scaleLinear, scalePoint } from "d3-scale";
  import type { ContributorSeries } from "$lib/types";

  const PALETTE = [
    "#1f77b4",
    "#ff7f0e",
    "#2ca02c",
    "#d62728",
    "#9467bd",
    "#8c564b",
    "#e377c2",
    "#7f7f7f",
    "#bcbd22",
    "#17becf",
  ];

  type Period = { label: string; start: string; end: string };

  interface $$Events {
    highlight: CustomEvent<string | null>;
  }

  const dispatch = createEventDispatcher<{ highlight: string | null }>();

  const {
    series = [],
    periods = [],
    interval = "year",
    width = 960,
    height = 540,
    loading = false,
    highlighted = null,
  } = $props<{
    series?: ContributorSeries[];
    periods?: Period[];
    interval?: "year" | "month";
    width?: number;
    height?: number;
    loading?: boolean;
    highlighted?: string | null;
  }>();

  const margin = { top: 56, right: 240, bottom: 56, left: 80 };

  function formatTick(label: string): string {
    if (interval === "month") {
      const [year, month] = label.split("-").map(Number);
      if (!Number.isNaN(year) && !Number.isNaN(month)) {
        const date = new Date(Date.UTC(year, month - 1, 1));
        return date.toLocaleDateString(undefined, {
          month: "short",
          year: "numeric",
        });
      }
    }
    return label;
  }

  const hasData = $derived(series.length > 0 && periods.length > 0);

  const periodLabels = $derived(
    hasData ? periods.map((period: Period) => period.label) : [],
  );

  const filteredSeries = $derived(
    series.filter((item: ContributorSeries) =>
      item.values.some(
        (value: ContributorSeries["values"][number]) => value.commits > 0,
      ),
    ),
  );

  const maxCommits = $derived(
    filteredSeries.length > 0
      ? Math.max(
          1,
          ...filteredSeries.map((item: ContributorSeries) =>
            item.values.reduce(
              (highest: number, value: ContributorSeries["values"][number]) =>
                Math.max(highest, value.commits),
              0,
            ),
          ),
        )
      : 1,
  );

  const chartWidth = $derived(width - margin.left - margin.right);
  const chartHeight = $derived(height - margin.top - margin.bottom);

  const xScale = $derived(
    scalePoint<string>()
      .domain(periodLabels)
      .range([margin.left, margin.left + chartWidth])
      .padding(0.5),
  );

  const yScale = $derived(
    scaleLinear()
      .domain([0, maxCommits])
      .nice()
      .range([margin.top + chartHeight, margin.top]),
  );

  const lineGenerator = $derived(
    line<{ label: string; commits: number }>()
      .curve(curveMonotoneX)
      .defined(
        (d) =>
          Number.isFinite(d.commits) &&
          Number.isFinite(xScale(d.label) ?? Number.NaN),
      )
      .x((d) => xScale(d.label) ?? margin.left)
      .y((d) => yScale(d.commits)),
  );

  type ChartSeries = {
    name: string;
    total: number;
    color: string;
    path: string;
    points: Array<{ label: string; commits: number; x: number; y: number }>;
  };

  const chartSeries = $derived<ChartSeries[]>(
    filteredSeries.map((item: ContributorSeries, index: number) => {
      const color = PALETTE[index % PALETTE.length];
      const valueByLabel = new Map(
        item.values.map((value: ContributorSeries["values"][number]) => [
          value.label,
          value.commits,
        ]),
      );
      const values = periodLabels.map((label: string) => ({
        label,
        commits: valueByLabel.get(label) ?? 0,
      }));

      return {
        name: item.name,
        total: item.total,
        color,
        path: lineGenerator(values) ?? "",
        points: values.map((value: { label: string; commits: number }) => ({
          ...value,
          x: xScale(value.label) ?? margin.left,
          y: yScale(value.commits),
        })),
      };
    }),
  );

  const xTicks = $derived.by<string[]>(() => {
    if (periodLabels.length <= 12) {
      return periodLabels;
    }

    const step = Math.ceil(periodLabels.length / 12);
    return periodLabels.filter(
      (_: string, index: number) => index % step === 0,
    );
  });

  const yTicks = $derived(yScale.ticks(6));

  const normalisedHighlight = $derived(
    highlighted ? highlighted.trim().toLowerCase() : null,
  );

  function isEmphasised(name: string): boolean {
    if (!normalisedHighlight) {
      return false;
    }
    return name.trim().toLowerCase() === normalisedHighlight;
  }

  function handleLegendEnter(name: string): void {
    dispatch("highlight", name);
  }

  function handleLegendLeave(): void {
    dispatch("highlight", null);
  }
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
  <svg
    {width}
    {height}
    role="img"
    aria-label={`Contributor trends per ${interval} line chart`}
  >
    <rect
      class="chart-bg"
      x={margin.left}
      y={margin.top}
      width={chartWidth}
      height={chartHeight}
    />

    <g class="axis axis--x">
      {#each xTicks as tick}
        {@const x = xScale(tick) ?? margin.left}
        <line
          x1={x}
          x2={x}
          y1={margin.top + chartHeight}
          y2={margin.top + chartHeight + 6}
        />
        <text {x} y={margin.top + chartHeight + 20} text-anchor="middle"
          >{formatTick(tick)}</text
        >
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
        <line
          x1={margin.left}
          x2={margin.left + chartWidth}
          y1={y}
          y2={y}
          class="grid"
        />
        <text x={margin.left - 12} y={y + 4} text-anchor="end">{commits}</text>
      {/each}
      <line
        x1={margin.left}
        x2={margin.left}
        y1={margin.top}
        y2={margin.top + chartHeight}
      />
    </g>

    {#each chartSeries as item}
      {@const emphasised = isEmphasised(item.name)}
      {@const dimmed = normalisedHighlight && !emphasised}
      <g
        class="series"
        class:emphasised
        class:dimmed
        onmouseenter={() => handleLegendEnter(item.name)}
        onfocus={() => handleLegendEnter(item.name)}
        onmouseleave={handleLegendLeave}
        onblur={handleLegendLeave}
        role="graphics-symbol"
        aria-label={item.name}
      >
        <path d={item.path} style={`stroke: ${item.color}`} />
        {#each item.points as point}
          {#if point.commits > 0}
            <circle
              cx={point.x}
              cy={point.y}
              r="3"
              style={`fill: ${item.color}`}
            />
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
      {interval === "year" ? "Year" : "Month"}
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
        {@const emphasised = isEmphasised(item.name)}
        {@const dimmed = normalisedHighlight && !emphasised}
        <g
          class="legend-item"
          class:emphasised
          class:dimmed
          transform={`translate(${margin.left + chartWidth + 24} ${margin.top + index * 26})`}
          tabindex="0"
          role="button"
          aria-pressed={emphasised}
          onmouseenter={() => handleLegendEnter(item.name)}
          onfocus={() => handleLegendEnter(item.name)}
          onmouseleave={handleLegendLeave}
          onblur={handleLegendLeave}
        >
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
  		cursor: default;
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
    transition:
      stroke-width 0.2s ease,
      opacity 0.2s ease;
  }

  .series circle {
    stroke: #fff;
    stroke-width: 1;
    transition: opacity 0.2s ease;
  }

  .series {
    cursor: default;
  }

  .series.emphasised path {
    stroke-width: 3;
  }

  .series.dimmed path,
  .series.dimmed circle {
    opacity: 0.25;
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

  .legend-item {
    outline: none;
    transition: opacity 0.2s ease;
  }

  .legend-item.dimmed {
    opacity: 0.45;
  }

  .legend-item.emphasised text {
    font-weight: 600;
  }

  .legend-item:focus-visible {
    outline: 2px solid var(--legend-focus, #2563eb);
    outline-offset: 3px;
    border-radius: 6px;
    padding: 2px;
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
