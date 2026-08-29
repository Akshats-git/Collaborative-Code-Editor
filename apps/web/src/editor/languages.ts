import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import type { Extension } from '@codemirror/state';

export interface Language {
  id: string;
  label: string;
  extension(): Extension;
}

/**
 * Deliberately short. Every entry is a package in the bundle, and the point of
 * this project is what happens underneath the editor rather than how many
 * grammars it ships with.
 */
export const LANGUAGES: readonly Language[] = [
  { id: 'typescript', label: 'TypeScript', extension: () => javascript({ typescript: true }) },
  { id: 'javascript', label: 'JavaScript', extension: () => javascript() },
  { id: 'python', label: 'Python', extension: () => python() },
  { id: 'json', label: 'JSON', extension: () => json() },
  { id: 'text', label: 'Plain text', extension: () => [] },
];

export const DEFAULT_LANGUAGE = 'typescript';

export function languageById(id: string | undefined): Language {
  return (
    LANGUAGES.find((language) => language.id === id) ??
    (LANGUAGES.find((language) => language.id === DEFAULT_LANGUAGE) as Language)
  );
}
