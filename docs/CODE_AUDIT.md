# Code audit — September 2026

This report records a full audit of the PointerViz codebase: what was checked,
each issue found, how it was resolved, and what remains. The fixes described
here are in the same commits as this document; regression tests for the
defects are in [`test/maintenance.test.js`](../test/maintenance.test.js).

## Scope and method

- Read every source module (`src/`, 29 files, about 4,000 lines), the test
  suites, build/CI configuration and all documentation.
- Ran the existing tests and production build as a baseline (all passing; the
  native-compiler suite skips without an LP64 compiler, as designed).
- Introduced ESLint and Prettier and used them to find unused code and
  inconsistent formatting. Scanned for exports and CSS selectors that nothing
  uses.
- Ran `npm audit` for dependency advisories.
- Exercised the production build in a browser under the GitHub Pages subpath
  (`/cs1010-pointers/`): playback, diagram editing, the inspector, challenge
  grading, the level editor, and a deliberately broken custom level.

## Summary

| Area | Found | Resolved | Deferred |
| --- | --- | --- | --- |
| User-facing defects | 12 | 12 | 0 |
| Structure and code debt | 14 | 14 | 0 |
| Dependencies and build | 3 | 3 | 0 |
| Documentation drift | 8 | 8 | 0 |
| Recommended follow-ups | 7 | 3 | 4 |

After the changes: ESLint reports 0 problems, Prettier reports every file
formatted, 280 tests pass (1 native-compiler suite skipped locally; it runs in
Linux CI), 7 Playwright browser tests pass, `npm audit` reports 0
vulnerabilities, and the production build has no warnings from project code.
Follow-ups 1, 2 and 4 were completed after the initial audit (section 7).

## 1. User-facing defects

Severity reflects impact on students and instructors: **High** means a feature
is unusable or the page is lost; **Medium** means wrong or lost data;
**Low** means confusing output.

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| D1 | High | **Level editor code was invisible.** `.editor-form textarea { background; color }` also matched `CodePanel`'s transparent overlay textarea, painting an opaque box over the syntax-highlighted code. Only line numbers were visible. Confirmed in the browser by re-applying the old rule. | Scoped the form rules to direct children (`.editor-form > textarea`), which also stops them stretching the grading checkboxes to full width. |
| D2 | High | **One bad custom level crashed Challenges.** `interpret(level.code)` ran unguarded during render; a level whose code no longer parses (grammar change, hand-edited storage) threw and unmounted the app, leaving a white screen. | The runner catches the error and shows "This level's reference code no longer runs: …" with a way back. |
| D3 | Medium | **Any render error blanked the whole app.** There was no error boundary. | Added `ErrorBoundary` around the active page, with a retry button; switching tabs resets it. |
| D4 | Medium | **Storage failures threw.** `saveCustomLevels` and `recordResult` called `localStorage.setItem` unguarded, so Check answer and Save level threw when storage is blocked (private browsing, disabled site data) or full. | All storage access goes through guarded helpers. Reads fall back to defaults; `saveCustomLevels` returns `false` and the editor tells the user to export their levels. |
| D5 | Medium | **Imported level packs were barely validated.** Only `id`, `code` and `kind` were checked. Duplicate IDs (re-importing a pack, or clashing with another pack) caused React key collisions and shared progress records, and arbitrary fields reached the UI. | `normalizeLevel()` coerces every stored or imported level to the documented shape; `mergeLevels()` renames colliding IDs (including against seed levels). Existing duplicates are repaired on load. The editor reports how many invalid levels were skipped. |
| D6 | Medium | **Inspector stored unchecked numbers.** The value field stored `Number(input)`, so `1.5` in an `int` or `300` in a `char` produced a state that later failed validation and C generation with a confusing message. | New `scalarFromInput()` rejects fractions for integer types and values outside the C type's range, with messages like "int values must be whole numbers". |
| D7 | Medium | **Latent subpath bug in parser initialization.** `initCParser()` defaulted to root-relative `'/tree-sitter-c.wasm'` and `'/' + file`. That is the same failure class as the GitHub Pages blank-page incident: correct at a domain root, broken under `/<repo>/`. The app happened to pass both paths explicitly. | Both paths are now required, with a clear error. |
| D8 | Low | **Level editor preview was blank on first open.** The preview was only computed on the first edit, so a valid default program showed "fix the code to see the preview". | The preview is initialized from the default code. |
| D9 | Low | **Grading feedback exposed internal IDs.** Heap diffs read like `heap allocation a3 should be freed`, contradicting the rule that internal IDs are hidden. | Diffs use display names (`'heap 1'`, `'values[2]'`). |
| D10 | Low | **Variable names could collide.** After `a`–`z`, "Add stack object" used `v<count>`, which could duplicate an existing name and make the diagram invalid. | Picks the first unused `v1`, `v2`, … |
| D11 | Low | **Unhelpful syntax errors.** A missing token produced `C syntax error near line 1: ""` because Tree-sitter's MISSING node has no text. | Reports the expected token: `missing ;`, `missing }`. |
| D12 | Low | **Object URL leak.** Exporting a level pack never revoked its blob URL. | Revoked after the download starts. |

## 2. Structure and code debt

| # | Issue | Resolution |
| --- | --- | --- |
| S1 | **No formatter or linter.** Lines reached 410 characters; `checker.js` was written in a minified style (`a=decay(a);b=decay(b);`); `parser.js` had an unindented `try` body and misindented blocks. | Adopted Prettier (`.prettierrc.json`, 100-column) and ESLint 9 with React and hooks rules (`eslint.config.js`). Reformatted the codebase once in a separate formatting-only commit. Added `npm run lint`, `format`, `format:check` and `check`; CI runs lint and the format check. |
| S2 | **Two test harnesses.** `core.test.js` and `roundtrip.test.js` used hand-rolled `PASS`/`FAIL` printing; the rest used `node:test`. `npm test` chained three commands and had to list every file by hand. | Both converted to `node:test` with the same assertions. `npm test` is `node --test "test/*.test.js"`, so new suites are picked up automatically. Added `test:playback` and `audit:n3088` scripts. |
| S3 | **Dead code.** `pipeline/ir.js` (a compatibility re-export) and its `typeToC` alias; no-op `resetAllocationIds()`; unused exports `CHAR`, `cloneType`, `isScalar`, `pointeeType`, `alignmentOf`, `refKey`, `rootRef`, `stackAllocationByName`, the `executeProgram` re-export; unused function `typeBase`; unused parameter `kind` in `layout.js`. | Removed. Imports now point at `machine/memory.js`. |
| S4 | **Over-broad module surfaces.** `allocationSize`, `roundedPath`, `getFrame`, `freshAllocationId`, `FrameGroupNode` and `MemoryAllocationNode` were exported but only used internally. | Made module-private. |
| S5 | **Duplicated helpers.** `samePath` was defined three times (interpreter, equivalence, and inline in `sameRef`); `sameRefValue` duplicated `sameRef`. | One exported `samePath` in `machine/memory.js`. |
| S6 | **Duplicated constants.** The primitive type list appeared in `types.js` and `MemoryInspector.jsx`; the minimum frame size (288 × 160) in `layout.js` and four places in `workspace.js`; edge colours were bare hex literals. | `PRIMITIVE_NAMES`, `FRAME_MIN` and `EDGE_COLORS` constants, with a note to keep the colours in sync with CSS. |
| S7 | **Duplicated UI logic.** The view-mode button group and the narrow-width `<select>` each re-implemented the same state change and produced differently capitalised status text. | A single `changeViewMode` handler. |
| S8 | **Misplaced shared component.** `CodePanel` lived in `Sandbox.jsx` but was imported by `Challenges` and `LevelEditor`. | Moved to `components/CodePanel.jsx`, with its magic scroll numbers named. |
| S9 | **Redundant or unreachable logic.** `setRefValue` checked liveness twice (the second check could never fire); `scalarEquals` had an unreachable second pointer-type check; `zeroInitialize` resolved a reference on every call just for an error message; `describePointer` ran three times per pointer row per render. | Simplified; each result is computed once. The more informative error message was kept. |
| S10 | **Import hygiene.** Four modules put an import above their header comment; eight files imported `React` without using it (the automatic JSX runtime is in use). | Fixed; ESLint now flags unused imports. |
| S11 | **Incorrect hook dependencies.** `Challenges` used `useMemo(..., [active])` as a reload trigger plus a dummy `bump` state; `MemoryInspector` omitted `state` from a `useMemo`. | Levels and progress are plain state refreshed on exit; the dependency list is correct and `react-hooks/exhaustive-deps` is enforced. |
| S12 | **Inline styles.** `LevelEditor` carried layout and typography in `style={...}` objects, with no narrow-screen layout. | Moved to CSS classes, with a single-column layout below 900px. |
| S13 | **Dead and duplicate CSS.** Rules for `.pointer-status`, `.readonly-field`, `.inspector-values`, `.scalar-editor`, `.actions`, `.pointer-depth` and `.mono` matched nothing; `button:disabled` was declared twice. | Removed. |
| S14 | **Unbounded component state init.** `useState(makeState())` and `useState(new Set())` built new objects on every render. The sandbox also recreated its "empty machine" state each render, which invalidated the canvas's memoized layout. | Lazy initializers, plus `useMemo` for the empty state. |

## 3. Dependencies and build

| # | Issue | Resolution |
| --- | --- | --- |
| B1 | `npm audit` reported advisories in dev-only packages (`browserslist`, `nanoid`, `postcss`, `baseline-browser-mapping`). Production dependencies had none. | Applied the non-breaking `npm audit fix`. |
| B2 | The production bundle was one 600 kB chunk, triggering Vite's size warning and forcing a full re-download on every deploy. | React, React Flow and Tree-sitter are split into separately cached chunks (largest now 184 kB); the warning is gone. |
| B3 | Remaining advisory: `esbuild ≤ 0.24.2` via Vite 5. It affects the **development server only**, not the deployed site. | Initially deferred, then resolved by follow-up 1: upgraded to Vite 8 (section 7). |

## 4. Documentation drift

| # | Where | Problem | Fix |
| --- | --- | --- | --- |
| C1 | `MAINTAINER_GUIDE.md` | Source tree omitted 11 modules and still listed `ir.js`. | Rewritten with one-line responsibilities. |
| C2 | `MAINTAINER_GUIDE.md` | "Struct ABI padding is not modelled" contradicted the LP64 layout with padding described elsewhere. | Corrected. |
| C3 | `MAINTAINER_GUIDE.md`, `ARCHITECTURE.md` | Said drag positions reset on every state change and locals are clamped; layout actually persists with undo/redo and frames grow. | Corrected. |
| C4 | `TESTING.md` | Hard-coded case counts had drifted (e.g. "22 core cases"); the playback suite was missing; step 1 referred to a "starter struct example" that no longer exists. | Counts removed, suites listed by command, step rewritten. |
| C5 | `README.md` | Instructions to extract a ZIP and `git init`, from before the project lived on GitHub. | Replaced with repository instructions and a link to CONTRIBUTING. |
| C6 | `DEPLOYMENT.md` | No guidance for the blank-page failure seen on first deployment. | Added a troubleshooting section (Pages source must be GitHub Actions). |
| C7 | `CONTRIBUTING.md` | Pre-PR checks did not include lint/format. | Now `npm run check`. |
| C8 | `CHANGELOG.md` | No record of this work. | Added an entry. |

## 5. Verification

- `npm run lint`: 0 problems.
- `npm run format:check`: all files formatted.
- `npm test`: 281 tests, 280 passed, 1 skipped (native LP64 comparison; it
  needs `cc` or WSL and is required in Linux CI).
- `npm run build -- --base /cs1010-pointers/`: success, no chunk warnings.
- Browser checks on the production build under the Pages subpath: parser
  loads, Run and step-through playback, adding and editing a stack object
  (fractional input rejected, valid input accepted), level editor code
  visible with the preview on first open, a broken stored level shows an
  error instead of crashing, and a diagram-to-code challenge graded
  correctly. No console errors.

## 6. Recommended follow-ups

Items 1, 2 and 4 are done; see section 7.

1. ~~**Upgrade Vite** to clear the dev-server `esbuild` advisory (B3).~~ Done.
2. ~~**Duplicate WASM in the build.**~~ Done.
3. **Split the two largest modules.** `machine/interpreter.js` (about 900
   lines) and `language/parser.js` mix statement, expression and declaration
   handling; splitting by concern would make review easier. This was not done
   in the audit because it is a behaviour-neutral refactor best done with
   focused review.
4. ~~**Component-level tests.**~~ Done as Playwright browser tests.
5. **Inspector labels show internal frame IDs** (for example
   `set_value() [frame3]`). Frame qualification is required by the address
   design to tell recursive calls apart, but a call number ("call #2") would
   read better than the internal ID.
6. **Choose a licence** before distributing the project (already noted in
   `CONTRIBUTING.md`).
7. **Changelog and version.** There are now two "Unreleased" sections and the
   package is still 2.2.1; cut a release (for example 2.3.0) when these ship.

## 7. Follow-up work completed

### Follow-up 1 — Vite 8

- Upgraded `vite` 5.4 → 8.3 and `@vitejs/plugin-react` 4.7 → 6.1. Vite 8
  bundles with Rolldown instead of Rollup and esbuild; `npm audit` now reports
  0 vulnerabilities across all dependencies.
- Moved the chunk configuration from the deprecated
  `build.rollupOptions.output.manualChunks` function to
  `build.rolldownOptions.output.codeSplitting.groups`. The output is
  unchanged: separate `react`, `react-flow` and `tree-sitter` chunks, largest
  177 kB.
- Vite 8 requires Node.js 20.19+ or 22.12+, so `engines.node` is now
  `>=22.12`. CI already runs current Node 22 and 24 releases.
- The only remaining build messages come from `web-tree-sitter` itself (its
  use of `eval` and of Node built-ins that are externalized for the browser),
  as under Vite 5.
- Verified the development server, the production build under the Pages
  subpath, and all browser tests.

### Follow-up 2 — duplicate Tree-sitter runtime

- Cause: the app passed `locateFile` pointing at a hand-vendored copy in
  `public/tree-sitter.wasm`, while `web-tree-sitter`'s JavaScript also
  references `new URL('tree-sitter.wasm', import.meta.url)`. Vite therefore
  emitted a second, hashed copy that was never fetched. All three files were
  byte-identical, but only by coincidence: the runtime JavaScript and WASM
  must match exactly, and the vendored copy would silently go stale on a
  `web-tree-sitter` upgrade.
- Fix: `App.jsx` imports `web-tree-sitter/tree-sitter.wasm?url` (a path the
  package exports) and passes it to `initParser`, and
  `public/tree-sitter.wasm` is deleted. The build now emits the runtime once,
  fingerprinted and base-path aware, always from the installed package. The
  grammar `tree-sitter-c.wasm` has no npm source in this project, so it stays
  in `public/`.
- Saves 205 kB per deployment and removes a version-drift hazard.

### Follow-up 4 — browser tests

- Added Playwright (`@playwright/test`, Chromium) with `npm run test:e2e`.
  `playwright.config.js` builds with the Pages base path and serves it with
  `vite preview`, so the tests exercise the deployed configuration.
- A shared fixture (`e2e/fixtures.js`) fails any test that logs a console
  error, throws an uncaught page error, or receives an HTTP 4xx/5xx response.
  This covers WASM and base-path loading implicitly.
- Seven tests in `e2e/sandbox.spec.js`, `challenges.spec.js` and
  `level-editor.spec.js` automate the section 5 checks: playback,
  range-checked editing and C generation, challenge grading (wrong and
  correct), broken and duplicate-ID stored levels, and level-editor
  visibility, preview, save and delete.
- Checked that the tests catch regressions: re-introducing defect D1's CSS
  makes the level-editor test fail with the opaque background colour.
- CI has a new `e2e` job on Ubuntu that uploads the HTML report and traces
  when it fails.
- Scope: these are end-to-end smoke tests, not isolated component tests. Drag,
  resize, arrow routing and keyboard interactions remain on the manual
  checklist in `TESTING.md`.
