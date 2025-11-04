<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { type ProgressEntry } from "$lib/components/contribution-progress";
  import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";

  type ProgressEntry = {
    id: string;
    message: string;
    timestamp: number;
    kind: "status" | "git";
    command?: string;
  };

  let {
    entries = [],
    loading = false,
    formatter,
    class: className,
    ...restProps
  }: {
    entries?: ProgressEntry[];
    loading?: boolean;
    formatter?: (value: number) => string;
    class?: string;
  } & WithoutChildrenOrChild<HTMLAttributes<HTMLElement>> = $props();

  const latestIndex = $derived(entries.length > 0 ? entries.length - 1 : -1);

  function formatTimestamp(value: number): string {
    if (formatter) {
      return formatter(value);
    }
    return new Date(value).toLocaleTimeString();
  }
</script>

{#if entries.length > 0}
  <Card
    data-slot="progress-panel"
    class={cn("bg-slate-50/70", className)}
    aria-live="polite"
    aria-busy={loading}
    {...restProps}
  >
    <CardHeader class="pb-4">
      <CardTitle class="text-base font-semibold text-slate-900">
        Progress updates
      </CardTitle>
      <CardDescription>
        {#if loading}
          Streaming the latest activity from git and the backend.
        {:else}
          Latest activity from git and the backend.
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3 pb-6">
      <ul class="grid gap-2 text-sm text-slate-700">
        {#each entries as entry, index (entry.id)}
          <li
            class={cn(
              "flex items-baseline gap-3 rounded-lg border border-transparent px-3 py-2 transition",
              index === latestIndex
                ? "border-blue-300 bg-blue-50 text-blue-700 shadow-sm"
                : "bg-white/80 text-slate-700",
            )}
          >
            <span class="font-mono text-xs uppercase text-slate-500">
              {entry.kind}
            </span>
            <span class="font-mono text-xs text-slate-500">
              {formatTimestamp(entry.timestamp)}
            </span>
            <span class="flex-1 text-left text-[0.93rem] leading-snug">
              {entry.message}
            </span>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>
{/if}
