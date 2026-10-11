/**
 * The sandbox draft, kept in localStorage so a reload does not lose work: the code, and the
 * diagram when it is being edited. Playback is not stored; Run reproduces it from the code.
 * Layout (box positions) is presentation and is not stored either.
 */
import { stateToFlow } from '../flow/layout.js';
import { validateAddressSpace } from '../machine/addresses.js';

const DRAFT_KEY = 'pointerviz.sandbox.v1';

/** A stored diagram must render, or restoring it would break the sandbox on every load. */
function usableDiagram(diagram) {
  try {
    if (!Array.isArray(diagram?.allocations) || !Array.isArray(diagram.frames)) return null;
    validateAddressSpace(diagram);
    stateToFlow(diagram, { editable: true, showExpired: true });
    return diagram;
  } catch {
    return null;
  }
}

/** { code, diagram } or null. Storage can be unavailable, and stored data can be malformed. */
export function loadDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (typeof stored?.code !== 'string') return null;
    return { code: stored.code, diagram: usableDiagram(stored.diagram) };
  } catch {
    return null;
  }
}

export function saveDraft(code, diagram) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ code, diagram }));
  } catch {
    /* private browsing or full storage: the draft lasts for this session only */
  }
}
