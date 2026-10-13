/**
 * Diagnostic categories. Every error a C program can trigger says why it was rejected,
 * so an unsupported feature or a simulator limit is never presented as invalid C.
 */

/** Violates C23 syntax or a constraint: a conforming compiler must diagnose it. */
export const INVALID = 'invalid';
/** Valid C whose execution reached undefined behavior. */
export const UNDEFINED = 'undefined';
/** Valid C outside the PointerViz Mini-C subset. */
export const UNSUPPORTED = 'unsupported';
/** Valid C that exceeds a browser-safety or representation limit of the simulator. */
export const LIMIT = 'limit';
/** A PointerViz defect or an invariant violation, not a property of the program. */
export const INTERNAL = 'internal';

export const DIAGNOSTIC_LABELS = {
  [INVALID]: 'Not valid C',
  [UNDEFINED]: 'Undefined behavior',
  [UNSUPPORTED]: 'Not supported by PointerViz',
  [LIMIT]: 'PointerViz limit',
  [INTERNAL]: 'PointerViz error',
};

export class CDiagnostic extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'CDiagnostic';
    this.kind = kind;
  }
}

export function diagnostic(kind, message) {
  return new CDiagnostic(kind, message);
}

/** Errors that were not created as a CDiagnostic are internal by definition. */
export function diagnosticKind(error) {
  return error instanceof CDiagnostic ? error.kind : INTERNAL;
}

/** Rewords an error while keeping its category, for errors rethrown with more context. */
export function rewrap(error, message) {
  return diagnostic(diagnosticKind(error), message);
}

/** The message as shown to a student, prefixed with its category. */
export function describeError(error) {
  return `${DIAGNOSTIC_LABELS[diagnosticKind(error)]}: ${error.message}`;
}
