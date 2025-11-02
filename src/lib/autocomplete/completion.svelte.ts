import { tick } from 'svelte';
import { fetchJSON } from '../autocomplete';

interface AutocompleteOptions {
  fetchSuggestions: (query: string, signal: AbortSignal) => Promise<{ items: any[]; total_count: number }>;
  fetchValidation: (query: string, signal: AbortSignal) => Promise<boolean>;
  onSelect: (value: string) => void;
  debounceTime?: number;
  minLength?: number;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === 'AbortError'
      : error instanceof Error && error.name === 'AbortError'
  );
}

export function createAutocomplete(getValue: () => string, options: AutocompleteOptions) {
  let value = $state(getValue());
  let suggestions = $state<string[]>([]);
  let suggestionNote = $state<string | null>(null);
  let suggestionIndex = $state(-1);


  let validationState = $state<'idle' | 'pending' | 'valid' | 'invalid'>('idle');
  let inputEl = $state<HTMLInputElement | null>(null);
  let fieldEl = $state<HTMLDivElement | null>(null);

  let suggestionAbort: AbortController | null = null;
  let validationAbort: AbortController | null = null;
  let suggestionDebounce: ReturnType<typeof setTimeout> | undefined;
  let validationDebounce: ReturnType<typeof setTimeout> | undefined;

  const minLength = options.minLength ?? 3;
  const debounceTime = options.debounceTime ?? 200;

  function abortSuggestions() {
    suggestionAbort?.abort();
    suggestionAbort = null;
  }

  function abortValidation() {
    validationAbort?.abort();
    validationAbort = null;
  }

  function resetSuggestions() {
    suggestions = [];
    suggestionNote = null;
    suggestionIndex = -1;
  }

  async function loadSuggestions(query: string) {
    abortSuggestions();
    const controller = new AbortController();
    suggestionAbort = controller;
    try {
      const data = await options.fetchSuggestions(query, controller.signal);
      suggestions = data.items
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object') {
            const login = 'login' in item && typeof item.login === 'string' ? item.login : null;
            if (login) {
              return login;
            }
            const name = 'name' in item && typeof item.name === 'string' ? item.name : null;
            if (name) {
              return name;
            }
          }
          return null;
        })
        .filter((item): item is string => Boolean(item));
      suggestionIndex = -1;
      suggestionNote = data.total_count > 20 ? 'Type more characters to refine results.' : null;
    } catch (error) {
      if (!isAbortError(error)) {
        suggestionNote = 'Failed to load suggestions.';
      }
    }
  }

  async function validate(query: string): Promise<boolean> {
    if (!query.trim()) {
      validationState = 'idle';
      return false;
    }
    abortValidation();
    const controller = new AbortController();
    validationAbort = controller;
    validationState = 'pending';
    try {
      const isValid = await options.fetchValidation(query, controller.signal);
      validationState = isValid ? 'valid' : 'invalid';
      return isValid;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }
      validationState = 'invalid';
      return false;
    } finally {
      if (validationAbort === controller) {
        validationAbort = null;
      }
    }
  }

  function handleInput(event: Event) {
    const newValue = (event.currentTarget as HTMLInputElement).value;
    value = newValue;
    resetSuggestions();
    abortSuggestions();
    abortValidation();

    if (newValue.length < minLength) {
      validationState = 'idle';
      return;
    }

    if (suggestionDebounce) {
      clearTimeout(suggestionDebounce);
    }
    suggestionDebounce = setTimeout(() => {
      void loadSuggestions(newValue);
    }, debounceTime);

    if (validationDebounce) {
      clearTimeout(validationDebounce);
    }
    validationDebounce = setTimeout(() => {
      void validate(newValue);
    }, debounceTime + 50); // Slightly longer debounce for validation
  }

  function scrollSuggestionIntoView(index: number) {
    if (index < 0 || typeof document === 'undefined') {
      return;
    }
    const id = `suggestion-${index}`;
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }

  async function handleKeyDown(event: KeyboardEvent) {
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
      // Allow the component using this to focus the next input
    } else if (event.key === 'Enter') {
      if (suggestions.length > 0 && suggestionIndex >= 0) {
        event.preventDefault();
        applySuggestion(suggestions[suggestionIndex]);
        return;
      }
      const trimmedValue = value.trim();
      if (trimmedValue.length >= minLength) {
        event.preventDefault();
        if (validationState !== 'valid') {
          const result = await validate(trimmedValue);
          if (!result) {
            return;
          }
        }
        options.onSelect(trimmedValue);
      }
    }
  }

  function applySuggestion(selected: string) {
    value = selected;
    resetSuggestions();
    validationState = 'valid';
    abortValidation();
    options.onSelect(selected);
  }

  function handleFocus() {
    const trimmedValue = value.trim();
    if (trimmedValue.length >= minLength && validationState !== 'valid') {
      abortValidation();
      validationState = 'pending';
      void validate(trimmedValue);
    }
    if (trimmedValue.length >= minLength) {
      abortSuggestions();
      void loadSuggestions(trimmedValue);
    }
  }

  return {
    get value() { return value; },
    get suggestions() { return suggestions; },
    get suggestionNote() { return suggestionNote; },
    get suggestionIndex() { return suggestionIndex; },
    get validationState() { return validationState; },
    get inputEl() { return inputEl; },
    set inputEl(node: HTMLInputElement | null) {
      inputEl = node;
    },
    get fieldEl() { return fieldEl; },
    set fieldEl(node: HTMLDivElement | null) {
      fieldEl = node;
    },
    setValidationState(state: 'idle' | 'pending' | 'valid' | 'invalid') {
      validationState = state;
    },
    handleInput,
    handleKeyDown,
    applySuggestion,
    resetSuggestions,
    handleFocus,
    validate,
    abortSuggestions,
    abortValidation,
  };
}
