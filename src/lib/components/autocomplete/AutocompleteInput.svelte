<script lang="ts">
  import { createAutocomplete } from '../../autocomplete/completion.svelte';
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
    validate: (query: string) => Promise<boolean>;
    abortSuggestions: () => void;
    abortValidation: () => void;
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
    validate,
    abortSuggestions,
    abortValidation,
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
  }: AutocompleteInputProps = $props();

  $effect(() => { 
    if (suggestions && value) {
      suggestionIndex = suggestions.indexOf(value);
    }
    console.log('AutocompleteInput suggestions:', suggestions);
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
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      const next = suggestionIndex - 1;
      suggestionIndex = next < 0 ? suggestions.length - 1 : next;
      scrollSuggestionIntoView(suggestionIndex);
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
      if (submitOnEmptyEnter && trimmedValue.length === 0 && suggestions.length === 0) {
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
</script>

<div class={cn("field field--with-suggestions", class_)} bind:this={fieldEl}>
  <label for={id}>{label}</label>
  <div class="input-wrapper relative">
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
            class={cn(inputClass, validationState === 'valid' && 'font-bold', 'w-full')}
            aria-invalid={validationState === 'invalid'}
            aria-expanded={ariaExpanded}
            aria-controls={ariaControls}
            aria-activedescendant={ariaActivedescendant}
          />    {#if suggestions.length > 0 || suggestionNote}
      <ul class="suggestions absolute top-[calc(100%+0.35rem)] left-0 right-0 list-none m-0 py-[0.35rem] border border-gray-200/10 rounded-[10px] bg-white/98 grid gap-1 shadow-lg z-10 max-h-56 overflow-y-auto" role="listbox" id={ariaControls}>
        {#each suggestions as suggestion, index}
          {console.log('Individual suggestion:', suggestion)}
          <li class="m-0 p-0">
            <button
              type="button"
              onclick={() => handleLocalApplySuggestion(suggestion)}
              role="option"
              aria-selected={index === suggestionIndex}
              class={cn(
                "w-full text-left px-3 py-2 bg-transparent border-0 text-sm text-gray-800 cursor-pointer",
                "hover:bg-blue-100 focus:outline-none",
                index === suggestionIndex && "active bg-blue-100"
              )}
              id={`${id}-suggestion-${index}`}
            >
              {suggestion}
            </button>
          </li>
        {/each}
        {#if suggestionNote}
          <li class="suggestions__note text-xs text-gray-600 px-3 py-1">{suggestionNote}</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>
