<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithoutChildren } from "$lib/utils.js";

  let {
    class: className,
    children,
    ...restProps
  }: WithoutChildren<HTMLAttributes<HTMLParagraphElement>> & {
    children?: Snippet | null;
  } = $props();
</script>

<p
  data-slot="card-description"
  class={cn("text-sm text-slate-600", className)}
  {...restProps}
>
  {@render children?.()}
</p>
