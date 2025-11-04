<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithoutChildren } from "$lib/utils.js";

  let {
    class: className,
    children,
    ...restProps
  }: WithoutChildren<HTMLAttributes<HTMLDivElement>> & {
    children?: Snippet | null;
  } = $props();
</script>

<div
  data-slot="card"
  class={cn(
    "rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
