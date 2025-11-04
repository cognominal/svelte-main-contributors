<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { cn } from '../../utils'; // Changed to relative path

  interface AutocompleteInputProps {
    value: string; // Keep value as a prop
    suggestions: string[];
    suggestionNote: string | null;
    validationState: 'idle' | 'pending' | 'valid' | 'invalid';
    handleInput: (event: Event) => void;
    handleKeyDown: (event: KeyboardEvent) => void;
    applySuggestion: (suggestion: string) => void;
    resetSuggestions: () => void;
    handleFocus: () => void;
    id: string;
    label: string;
    placeholder: string;
    disabled?: boolean;
    class?: string;
    inputClass?: string;
    ariaControls?: string;
    ariaExpanded?: boolean;
    ariaActivedescendant?: string;
    inputEl?: HTMLInputElement | null;
    fieldEl?: HTMLDivElement | null;
    submitOnEmptyEnter?: boolean;
    highlightMatch?: boolean;
    suggestionsPending?: boolean;
    getSuggestionBadge?: (suggestion: string) => string | null | undefined;
  }

  let { 
    value,
    suggestions,
    suggestionNote,
    validationState,
    handleInput,
    handleKeyDown,
    applySuggestion,
    resetSuggestions,
    handleFocus,
    id,
    label,
    placeholder,
    disabled = false,
    class: class_ = '',
    inputClass = '',
    ariaControls,
    ariaExpanded,
    ariaActivedescendant,
    inputEl = $bindable<HTMLInputElement | null>(null),
    fieldEl = $bindable<HTMLDivElement | null>(null),
    submitOnEmptyEnter = false,
    highlightMatch = false,
    suggestionsPending = false,
    getSuggestionBadge,
  }: AutocompleteInputProps = $props();

  const isLoading = $derived(suggestionsPending || validationState === 'pending');
  const suggestionBadges = $derived(
    suggestions.map((suggestion) => getSuggestionBadge?.(suggestion) ?? null)
  );

  $effect(() => { 
    if (suggestions && value) {
      suggestionIndex = suggestions.indexOf(value);
    } else {
      suggestionIndex = -1;
    }
  });

  function scrollSuggestionIntoView(index: number) {
    if (index < 0 || typeof document === 'undefined') {
      return;
    }
    const suggestionId = `${id}-suggestion-${index}`;
    document.getElementById(suggestionId)?.scrollIntoView({ block: 'nearest' });
  }

  function handleLocalKeyDown(event: KeyboardEvent) {
    const trimmedValue = value.trim();

    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      const next = suggestionIndex + 1;
      suggestionIndex = next >= suggestions.length ? 0 : next;
      scrollSuggestionIntoView(suggestionIndex);
      handleKeyDown(event);
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      const next = suggestionIndex - 1;
      suggestionIndex = next < 0 ? suggestions.length - 1 : next;
      scrollSuggestionIntoView(suggestionIndex);
      handleKeyDown(event);
      return;
    }
    if (event.key === 'Escape') {
      if (suggestions.length > 0 || suggestionNote) {
        event.preventDefault();
        resetSuggestions();
      }
      return;
    }
    if (event.key === 'Tab' && suggestions.length > 0) {
      event.preventDefault();
      const targetIndex = suggestionIndex >= 0 ? suggestionIndex : 0;
      applySuggestion(suggestions[targetIndex]);
      // Let the parent component handle focus after tab
    } else if (event.key === 'Enter') {
      if (suggestions.length > 0 && suggestionIndex >= 0) {
        event.preventDefault();
        applySuggestion(suggestions[suggestionIndex]);
        return;
      }
      if (submitOnEmptyEnter && trimmedValue.length === 0 && suggestionIndex < 0) {
        event.preventDefault();
        const form = fieldEl?.closest('form');
        form?.requestSubmit();
        return;
      }
      // Let the parent component handle form submission or other enter behavior
    }
    handleKeyDown(event);
  }

  function handleLocalApplySuggestion(suggestion: string) {
    applySuggestion(suggestion);
    // Optionally, emit an event for the parent to handle focus or other actions
  }

  let suggestionIndex = $state(-1);

  function handleDocumentPointerDown(event: PointerEvent | MouseEvent) {
    if (!fieldEl) {
      return;
    }
    const target = event.target as Node | null;
    if (target && fieldEl.contains(target)) {
      return;
    }
    suggestionIndex = -1;
    resetSuggestions();
  }

  function handleDocumentFocusIn(event: FocusEvent) {
    if (!fieldEl) {
      return;
    }
    const target = event.target as Node | null;
    if (target && fieldEl.contains(target)) {
      return;
    }
    suggestionIndex = -1;
    resetSuggestions();
  }

  onMount(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('focusin', handleDocumentFocusIn, true);
  });

  onDestroy(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
    document.removeEventListener('focusin', handleDocumentFocusIn, true);
  });
</script>

<div class={cn("flex flex-col gap-2", class_)} bind:this={fieldEl}>
  <label class="font-semibold text-sm" for={id}>{label}</label>
  <div class="relative">
          <input
            {id}
            name={id}
            bind:value={value}
            {placeholder}
            {disabled}
            bind:this={inputEl}
            oninput={handleInput}
            onkeydown={handleLocalKeyDown}
            onfocus={handleFocus}
            class={cn(
              'w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200',
              highlightMatch && 'font-bold',
              inputClass
            )}
            aria-invalid={validationState === 'invalid'}
            aria-busy={isLoading ? 'true' : undefined}
            aria-expanded={ariaExpanded}
            aria-controls={ariaControls}
            aria-activedescendant={ariaActivedescendant}
          />
    {#if isLoading}
      <span class="spinner" role="status" aria-live="polite">
        <span class="sr-only">Loading</span>
      </span>
    {/if}
    {#if suggestions.length > 0 || suggestionNote}
      <ul class="absolute left-0 right-0 z-10 mt-2 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white/95 p-1.5 shadow-lg" role="listbox" id={ariaControls}>
        {#each suggestions as suggestion, index}
          <li>
            <button
              type="button"
              onclick={() => handleLocalApplySuggestion(suggestion)}
              role="option"
              aria-selected={index === suggestionIndex}
              class={cn(
                'w-full rounded-lg px-3 py-2 text-left text-sm text-slate-800 focus:outline-none',
                'flex items-center justify-between gap-3',
                'hover:bg-blue-50 focus:bg-blue-50',
                index === suggestionIndex && 'bg-blue-100'
              )}
              id={`${id}-suggestion-${index}`}
            >
              <span class={cn('truncate', highlightMatch && 'font-semibold')}>
                {suggestion}
              </span>
              {#if suggestionBadges[index]}
                <span class="text-xs uppercase tracking-wide text-slate-400">
                  {suggestionBadges[index]}
                </span>
              {/if}
            </button>
          </li>
        {/each}
        {#if suggestionNote}
          <li class="px-3 py-1 text-xs text-slate-500">{suggestionNote}</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>

<style>
  .spinner {
    position: absolute;
    top: 50%;
    right: 0.75rem;
    width: 1rem;
    height: 1rem;
    border-radius: 9999px;
    border: 2px solid rgba(148, 163, 184, 0.35);
    border-top-color: rgba(59, 130, 246, 0.9);
    animation: spinner-rotate 0.75s linear infinite;
    transform: translateY(-50%);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes spinner-rotate {
    from {
      transform: translateY(-50%) rotate(0deg);
    }
    to {
      transform: translateY(-50%) rotate(360deg);
    }
  }
</style>
