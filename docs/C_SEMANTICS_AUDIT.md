# C semantics audit — 2026-09-14

The audit checked the parser, type system, execution, memory references, canonical C generation and diagram validation. Existing playback, layout and integration tests were retained. This is a tested C11 subset with explicit implementation choices; it is not a claim of complete ISO C conformance.

## Reference and implementation model

The reference is WG14's [C11 committee draft N1570](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf). Relevant clauses are 6.3 (conversions), 6.4.4 (constants), 6.5 (expressions and sequencing), 6.5.2.2 (calls), 6.5.3.2–4 (address, indirection and sizeof), 6.5.5–9 (arithmetic and comparisons), 6.7.2.1 (structures), 6.7.9 (initialization), 6.8 (control flow) and 7.22.3 (allocation).

The selected implementation uses LP64 sizes, ASCII, signed 8-bit char, two's-complement narrowing, binary32 float and binary64 double. The simulator does not adopt Windows LLP64 sizes. Struct alignment is the maximum member alignment; sizes include internal and tail padding. Distinct allocations use separate object identities rather than native addresses.

## Findings fixed

| Area | Previous discrepancy | Corrected behavior |
| --- | --- | --- |
| `sizeof` | Type inference could evaluate updates, assignments and member dereferences | Type-only traversal, including null/uninitialized operands and calls; no effects |
| Literals | Character constants typed as char; floating tokens treated as integers; suffix types lost | C int character constants, typed decimal floats and supported integer suffixes; explicit rejection of unsupported forms |
| Arithmetic | Fractional division truncated; storage conversions and overflow omitted | Integer promotions, usual conversions, floating division, binary32 rounding, signed overflow diagnostics, unsigned wrap |
| Struct layout | Sum of field sizes omitted padding | Explicit LP64 alignment and padding |
| Arrays | Nested dimensions and pointer-to-array declarators could be reversed | Correct declarator binding, subarray decay and multidimensional addressing |
| Pointer arithmetic | Selected the first array in a path and rejected scalar one-past arithmetic | Preserves the immediate containing array; singleton objects support offsets zero and one |
| Addresses | Rejected `&a[n]` at one-past and `&*NULL` | C address/indirection cancellation; one-past formation without access |
| Comparisons | Adjacent row boundary addresses compared unequal; direct struct-member order rejected | Compare in-allocation byte offsets for equality and member declaration order where defined |
| Null conversions | Any runtime zero accepted as a null pointer constant; incompatible typed nulls accepted | Integer constant-expression zero required; pointer compatibility checked independently of stored value |
| Lifetime | Dangling pointer arithmetic/copies/comparisons could succeed | Diagnose subsequent evaluation while retaining history for visualization |
| Allocation | `free` returned int zero | `free` has void type; heap/base-pointer/lifetime checks remain enforced |
| Initialization | Brace elision and scalar braces rejected | Aggregate cursor implements brace elision, zero fill and scalar braces; returned struct scalar members supported |
| Constraints | Invalid code in skipped branches escaped checks | A pre-execution checker validates all functions, branches, calls, lvalues and returns |
| Sequencing | Expressions such as `i++ + i` produced a deterministic result | Conflicting scalar accesses diagnosed through resolved references, including aliases and call arguments |
| Unsupported syntax | Globals, qualifiers, storage classes, macros and some declarations silently discarded | Explicit diagnostics; type-definition cycles and duplicate definitions rejected |
| Canonical generation | Some one-past/nested declarations and scalar literals could not reproduce the state | Typed literals, recursive declarator printing, singleton one-past references and checked round trips |
| Memory validation | Invalid references could extend arrays or crash grading | Bounds checks on writes and structured validation errors for bad targets/values |
| Resource limits | Nested aggregates could bypass per-array limits | Total scalar storage limited per allocation; parser/tree resources released after parsing |

## Verification

The new semantic suite contains 153 named tests, including 76 defined-behavior fixtures, rejection cases, canonical round trips and direct memory validation checks. Existing suites add 22 core, 23 parser/round-trip, and 29 layout/playback/integration cases. Including the native comparison test, all 228 checks pass.

The same 76 defined-behavior fixtures are compiled as C11 with the native Ubuntu C compiler, `-fsanitize=undefined` and `-fno-sanitize-recover=undefined`. Each native result is checked against both an independent expected value and the interpreter result. Invalid/undefined programs are tested for simulator diagnostics, never assigned a portable native result. Native comparison uses static assertions to require the selected LP64/signed-char model.

`npm test` includes the native test; it reports a skip when a suitable compiler command is unavailable. Linux CI requires the compiler check to run. `npm run test:semantics` runs the semantic suite; `npm run test:native` runs the differential comparison. On this Windows workspace the native comparison runs through the installed Ubuntu WSL distribution using `POINTERVIZ_WSL_DISTRO=Ubuntu-20.04`.

The production build passes with existing Tree-sitter browser-externalization/eval and bundle-size warnings. Browser interaction was not manually re-audited in this change; the existing automated visualization suites were rerun.

## Remaining boundaries

- C is not one fixed ABI. LP64 sizes, character signedness, narrowing and separate allocation identities are explicit implementation choices, not universal C rules.
- Exact 64-bit integer values outside JavaScript's safe integer range are rejected. Complete floating-environment, NaN/infinity, extended-type and byte-representation behavior is outside scope.
- Qualifiers, storage classes, globals, prototypes, block-scoped types, macros, casts, general void-pointer conversions, unions, bitfields, VLAs, strings and many library functions are explicitly unsupported. Functions must be defined before use. Standard include lines are recognized without processing header contents; NULL, malloc and free are built in.
- Allocation is typed, bounded and always succeeds. Zero-size allocation, failures, byte aliasing, effective-type changes and malloc through pointer-to-array destinations are unsupported.
- Sequencing diagnostics cover modeled scalar reads/writes; this is not a general compiler UB analyzer. The machine chooses left-to-right operand evaluation where C leaves order unspecified. Programs whose observable result depends on unspecified order are not promised a unique portable answer.
- Main's final frame is retained as an inspectable terminal snapshot. Returned frames, freed objects and dangling provenance are diagnostic history, not usable live C storage. Missing returns in non-void helper functions are conservatively diagnosed, even when a native caller might discard the result.
- Canonical generation still requires a single live main frame. Unreachable allocations that need an extra source pointer, expired stack objects and some heap graphs reachable only through interior struct fields are rejected rather than emitted as misleading C. Array members of temporary struct values are unsupported.
- Automated tests provide evidence for the covered subset, not proof that every possible input is conforming. Further language additions should add both positive native fixtures and negative constraint/UB cases.
