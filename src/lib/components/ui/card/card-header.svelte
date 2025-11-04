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
  data-slot="card-header"
  class={cn("flex flex-col space-y-1.5 p-6", className)}
  {...restProps}
>
  {@render children?.()}
</div>
