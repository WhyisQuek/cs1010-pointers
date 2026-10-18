/**
 * Memory canvas display preferences, shared by every canvas and remembered across reloads.
 * They are presentation only: never part of MemoryState, grading, or undo history.
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * The first three presets draw the same boxes at the same size; only what is shown in them
 * changes. Structure redraws lists and trees as compact nodes in their own shape, so it lays
 * the canvas out afresh at every step; editable diagrams show it as Arrows.
 */
export const VIEW_MODES = Object.freeze([
  { id: 'both', label: 'Both' },
  { id: 'arrows', label: 'Arrows' },
  { id: 'addresses', label: 'Addresses' },
  { id: 'structure', label: 'Structure', readOnly: true },
]);

/** How char objects read: the stored number, or the character it encodes. */
export const CHAR_MODES = Object.freeze([
  { id: 'number', label: 'Number', example: '97' },
  { id: 'character', label: 'Character', example: "'a'" },
]);

function preference(key, modes, fallback) {
  // Tells other mounted canvases (sandbox, challenges, level editor) that the choice changed.
  const event = `pointerviz:${key}`;
  const valid = value => modes.some(m => m.id === value);
  // Fallback when storage is unavailable (private browsing), so the choice lasts the session.
  let session = fallback;
  const load = () => {
    try {
      const stored = localStorage.getItem(key);
      if (valid(stored)) return stored;
    } catch {
      /* storage blocked: use the session value */
    }
    return session;
  };
  const save = value => {
    if (!valid(value)) return;
    session = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the choice lasts for this session only */
    }
    window.dispatchEvent(new CustomEvent(event, { detail: value }));
  };
  /** [value, setValue], kept in step across canvases and browser tabs. */
  const usePreference = () => {
    const [value, setLocal] = useState(load);
    useEffect(() => {
      const sync = () => setLocal(load());
      window.addEventListener(event, sync);
      window.addEventListener('storage', sync);
      return () => {
        window.removeEventListener(event, sync);
        window.removeEventListener('storage', sync);
      };
    }, []);
    return [value, useCallback(next => save(next), [])];
  };
  return { load, save, usePreference };
}

const view = preference('pointerviz.view.v1', VIEW_MODES, 'both');
const chars = preference('pointerviz.chars.v1', CHAR_MODES, 'number');

export const loadView = view.load;
export const saveView = view.save;
export const useViewPreference = view.usePreference;
export const useCharPreference = chars.usePreference;
