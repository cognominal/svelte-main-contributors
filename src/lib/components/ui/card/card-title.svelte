<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithoutChildren } from "$lib/utils.js";

  let {
    class: className,
    children,
    ...restProps
  }: WithoutChildren<HTMLAttributes<HTMLHeadingElement>> & {
    children?: Snippet | null;
  } = $props();
</script>

<h3
  data-slot="card-title"
  class={cn("text-lg font-semibold leading-none tracking-tight", className)}
  {...restProps}
>
  {@render children?.()}
</h3>
