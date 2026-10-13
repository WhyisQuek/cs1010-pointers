# C behavior audit against N3088

Date: 2026-09-20, revised 2026-10-13. The original audit covered the working tree, including local edits, based on commit `3160cc2`. The revision re-verified every finding at commit `1d7ee21` (23 commits later), merged additional findings, and extended the probe set. Application behavior was not changed by either pass.

Reference: [WG14 N3088](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf), the requested C23 draft. When this audit was written the project advertised a bounded **C11 subset**; the [language contract](SUPPORTED_C.md) now targets a bounded **C23 subset** and lists the deviations below as known. The earlier [C11 audit](C_SEMANTICS_AUDIT.md) remains historical evidence, not a C23 conformance claim.

The audit found **13 groups of behavioral discrepancies**, plus **7 groups of subset limitations**. The accompanying [reproduction tool](../test/audit-n3088.mjs) contains 70 probes. Before any fixes, 51 exposed these discrepancies/limitations and 19 matched (17 working controls and 2 probes resolved since the original audit). After Phase 1 ([status below](#status-after-phase-1-2026-10-13)), 37 still exposed discrepancies or limitations. After Phase 2 ([status](#status-after-phase-2-2026-10-14)), **14 do and 56 match**: the C23 additions and type spellings of L1/L2/L5/L7 (Phase 3), the 64-element array limit (L6), and B3's struct-tag identity. These are targeted examples, not independent defects or a statistical conformance score.

## Status after Phase 1 (2026-10-13)

| Finding | Status |
| --- | --- |
| B10 | **Fixed.** `true`/`false` have type `bool`. They are predefined constants, not integer constants (6.6p8), so `int *p = false;` is now invalid, matching GCC 13. |
| B5 | **Fixed.** Integer constants take the first representable type in their 6.4.4.1p6 list; a constant with no such type is invalid (6.4.4p2). Hexadecimal constants above `LONG_MAX` now get `unsigned long`. |
| B7 | **Fixed for `nullptr`.** `nullptr` has type `nullptr_t` (8 bytes): it converts only to pointers and `bool`, compares with null pointer constants and pointers, and cannot be used in arithmetic or ordering. `nullptr_t` objects remain unsupported. **`NULL` decision:** `NULL` stays the integer constant `0`, a conforming choice (7.21p4) documented in the language contract, until `void *` exists (Phase 2.6). The `B7-NULL-*` probes now expect that model and are excluded from the native comparison, since glibc differs. |
| B4 | **Fixed.** `sizeof`, member access and pointer arithmetic require the struct to be defined earlier in the source. |
| B6 | **Fixed.** Pointer arithmetic and subscripting require a complete pointee type, so `void *` arithmetic is invalid even inside `sizeof`. |
| B8 | **Fixed.** Reading a pointer member of a returned struct applies the same dangling-pointer check as every other pointer read. |
| B3 | **Partly fixed.** A block-scope object or parameter hides a file-scope typedef in `sizeof` and type names, and a typedef/function name clash is invalid. Separate struct-tag identity for anonymous typedef'd structs is not done: it changes how structs are stored, generated as C and graded. `typedef struct {int x;} S; struct S {...};` is rejected as not supported rather than as invalid C. |

Regression tests for these fixes are in `test/c23.test.js`. Their expected values were also checked against GCC 13 (`-std=c2x`). The native differential test (`test/native-c.test.js`) now compiles its 88 fixtures as C23; a C11 fixture asserting that `false` is a null pointer constant was removed.

## Status after Phase 2 (2026-10-14)

| Finding | Status |
| --- | --- |
| B9 | **Fixed.** Integer values are exact across the full 64-bit range: a value is stored as a JavaScript number while that is exact, and as a `BigInt` beyond 2^53. Unsigned 64-bit arithmetic wraps; drafts, generated C (`18446744073709551615UL`, `(-9223372036854775807L - 1)`), the diagram editor and `printf` all keep the exact value. This also removes the representation part of L6. |
| B1 | **Fixed.** A braced scalar initializer keeps its null-pointer-constant classification. |
| B2 | **Fixed.** In a constant expression, the skipped operand of `&&`/`\|\|` must still have constant form but is not evaluated. |
| L5 (empty initializers) | **Fixed.** `= {}` zero-initializes scalars, pointers, arrays and structs; it remains invalid for an array of unknown size. |
| L4 | **Fixed.** Falling off the end of a non-`void` function is diagnosed only when the caller uses the value. |
| A2 | **Fixed.** The `malloc` argument converts to `size_t` from any arithmetic type; a negative floating size is undefined behavior. |
| A1 | **Fixed** by a redesign. `malloc` returns `void *` to an untyped block of the requested size, aligned to 16 bytes. Converting a pointer to it into `T *` gives it its effective type (6.5p6) as `floor(bytes / sizeof(T))` objects, keeping the requested size for generated C. A block too small for one `T` stays untyped, and dereferencing it is undefined behavior. Discarded results, `free(malloc(n))`, comparisons and pointer-to-array destinations all work. `malloc(0)` returns `NULL`, an implementation choice (7.24.3p1) that differs from glibc. |
| A3 | **Fixed.** `free` accepts any pointer whose address is the block's start, so a pointer to the first struct member works; interior and one-past pointers are still undefined. |
| L3 | **Fixed.** `void *` is supported: it converts to and from any object pointer, compares equal with them, and designates the outermost object at its address. Pointers to structs that are never defined are allowed; objects, `sizeof` and member access through them are invalid. |
| New check | Access through a pointer whose type differs from the object (now possible via `void *`) is diagnosed: undefined behavior in general, not supported for the character and signed/unsigned cases that 6.5p7 allows. |

Regression tests for Phases 1 and 2 are in `test/c23.test.js` (92 cases); apart from the implementation-defined `malloc(0)`, every expected value and validity was also checked against GCC 13 (`-std=c2x`). Generated C was checked for each new heap shape (untyped blocks, `void *` aliases, trailing bytes, first-member pointers): regenerating it reproduces an equivalent state. The only exception is a block reached solely through a pointer to a whole array, which generation does not yet support. Tests that asserted the old limits (the exact-integer limit, rejected `malloc` forms, unsupported `{}`) were replaced by tests of the new behavior.

## Revision notes (2026-10-13)

- **Resolved since the original audit:** `int f(int a[])` is now accepted (L1), and `bool`/`true`/`false` are predefined as if `<stdbool.h>` were included (L5). Both probes now match. Predefining `bool` without the header is a documented C11 deviation, consistent with C23.
- **New findings:** B9 (64-bit unsigned wraparound rejected, contradicting the language contract), the `NULL` extension of B7, the C23 alignment qualification of A1, and limitation group L7.
- **New since the audit, now probed:** string literals and `printf`. Initialization of char arrays from literals, `printf` return values and diagnostics for writing to string literals, over-long initializers, `%s` on `NULL` or unterminated arrays, and mismatched format arguments all behaved correctly in additional probes. Seven new controls cover undefined-behavior detection that works.

## Allocation findings

### A1 — High: allocations are modeled as destination-typed objects

The reported example reproduces in `evalCall` (`src/machine/execution/calls.js`), in the `malloc` size check:

```c
#include <stdlib.h>
int main(void) {
    int *a = malloc(1);
    free(a);
}
```

PointerViz reports `malloc size 1 is not a positive multiple of sizeof(int) (4)`.

Under C11, allocation and pointer assignment are allowed; accessing an `int` needs sufficient storage. In this project's four-byte `int` model, `*a = 42` would exceed a one-byte allocation. The declaration itself is not that access.

**C23 qualification.** N3088 7.24.3p1 narrows the alignment guarantee: the returned pointer is suitably aligned for any type with fundamental alignment *and size less than or equal to the size requested*. A one-byte allocation therefore need not be aligned for `int`, and converting a misaligned pointer is undefined (6.3.2.3p7). Under N3088, `int *a = malloc(1)` and `malloc(0)` into `int *` are implementation-dependent rather than clearly valid; mainstream allocators return 16-byte-aligned storage, so they work in practice. The rejection is still an over-restriction for C11 and for the cases below whose size covers the accessed type (e.g. `malloc(5)`), so the finding and its priority stand.

The same design produces several other rejections, all reproduced:

| Example inside `main` | Current outcome |
| --- | --- |
| `int *p=malloc(5); if(p){*p=7;} free(p);` | Rejects trailing byte |
| `int *p=malloc(0); free(p);` | Rejects zero size |
| `malloc(4);` | Requires a destination pointer type |
| `free(malloc(4));` | Requires a destination pointer type |
| `int result=malloc(4)!=NULL;` | Requires a destination pointer type |
| `int (*p)[2]=malloc(sizeof(int[2])); free(p);` | Explicitly rejects pointer-to-array destination |

Zero-size allocation has implementation-defined outcomes; the pointer must not access an object. The allocation function can also return null on failure. [7.24.3p1](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf#page=378).

This is a documented simulator restriction, not a newly introduced regression. Fixing only the modulus check is insufficient: `evalCall` constructs `heapAllocationType(expectedType.to, count)`, and the rest of the machine expects complete typed values. Rounding down loses storage; rounding up invents storage.

Recommended design: store requested byte length and allocation identity independently of the pointer's type; represent pointer views separately; check access width, alignment, lifetime, and effective type when accessing memory. Define a zero-size policy, an alignment policy consistent with 7.24.3p1, and an optional allocation-failure mode. Carry byte sizes through snapshots, visualization, validation, grading, and generated C.

### A2 — Medium: `malloc` arguments bypass normal parameter conversions

`char *p=malloc(1.0); free(p);` reports `malloc size must be integer`.

Conversion to `size_t` makes this argument 1. [6.5.2.2, 6.3.1.4, 7.24.3.6](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf#page=380).

The `Call` case of `checkProgram` in `src/language/checker.js` insists on an integer expression, and `evalCall` in `src/machine/execution/calls.js` uses its value without conversion to `SIZE_T`. Route built-in calls through parameter checking/conversion, then apply simulator resource limits. Do not confuse out-of-range floating conversions with this in-range example.

### A3 — Medium: `free` rejects a first-member pointer at the allocation base

```c
struct S { int x; };
/* Inside main: */
struct S *p=malloc(sizeof(struct S));
if(p){free(&p->x);}
```

The interpreter reports an interior-pointer error in the `free` branch of `evalCall` (`src/machine/execution/calls.js`). The native probes accept and execute this example. A structure and its first member share the starting address after conversion. [6.7.2.1p17, 7.24.3.3](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf#page=121).

The current check demands an exact reference path (`[]` or `[0]`). Model the `void *` argument conversion and allocation-base match while preserving allocation identity. Continue rejecting nonzero interior offsets, one-past values, stack pointers, and already freed allocations.

## Discrepancies in implemented language behavior

Priority reflects misleading teaching results and the reach of the affected code, rather than security severity.

| ID / priority | Reproducer | Observed behavior | Expected behavior / N3088 |
| --- | --- | --- | --- |
| B1 / Medium | `int *p={0};` | Rejects `int` to `int *`; `{NULL}` and `int *a[1]={{0}}` also fail | Accept scalar braces; 6.7.10p12 |
| B2 / Medium | `int *p=0 && (1/0);` | Reports division by zero; skipped signed overflow also throws | Short-circuit constant evaluation; 6.6p17, 6.5.13 |
| B3 / High | `typedef struct {long x;} S;` then `int S=1; int result=sizeof(S);` in `main` | Produces **8** | **4** under selected ABI; 6.2.1p4 |
| B4 / Medium | `int main(void){int n=sizeof(struct S);} struct S{int x;};` | Accepts and produces 4; `sizeof(p->x)` likewise sees future fields | Incomplete-type constraint; 6.5.3.4p1, 6.7.2.3 |
| B5 / High | `unsigned long n=18446744073709551616UL;` | Silently produces **0**; `malloc(18446744073709551617UL)` allocates one byte | Constant must have a type; constraint 6.4.4p2, type list 6.4.4.1p6 |
| B6 / Medium | `sizeof(malloc(4)+1)` | Accepts and produces 8 | Invalid `void *` arithmetic; 6.5.6p2 |
| B7 / High | `sizeof(nullptr)`; `int n=nullptr;`; `nullptr+1` | Produces 4, 0, and 1 respectively | Distinct non-arithmetic type; pointer-sized here; 6.4.4.5, 7.21.2 |
| B8 / Medium | Returned-struct example below | Completes comparison and produces 0 | Dangling-pointer use is UB; 6.2.4p2 |
| B9 / High | `size_t n=0; n--;`; `unsigned long u=-1;` | Rejects: "integer exceeds the exact JavaScript safe-integer range" | Wraps modulo 2^64; 6.2.5p11, 6.3.1.3p2 |
| B10 / Medium | `int result=sizeof(true);` | Produces **4** (`true` has type `int`) | **1**: `false` and `true` are constants of type `bool`; 6.4.4.5p3 |

Clause references in this table are to [N3088](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf). B5 is assessed against the project's declared integer types; the audit does not assume that every C implementation lacks wider extended types. B8 concerns the project's promised diagnostic coverage: ISO C does not require a diagnostic for every UB execution.

Root causes and repair directions:

- **B1:** `evalExpression` in `src/machine/execution/expressions.js` overwrites `integerConstant` on the outer `InitializerList`, losing the inner zero's classification. Preserve the scalar initializer's constant-expression information.
- **B2:** `constant` inside `checkProgram` (`src/language/checker.js`) evaluates both binary operands before handling `&&`/`||`. Keep checking both operands' constraints, but evaluate only the required operand values. Runtime short-circuiting already works.
- **B3:** The `sizeof_expression` case of `parseExpression` (`src/language/parse/expressions.js`) consults a global alias registry instead of lexical visibility. The same registry also conflates an anonymous struct's synthetic name with a real tag: `typedef struct {int x;} S; struct S{long y;};` is rejected. Conversely, a typedef and a function named `S` in the same scope are accepted. Use separate tag identities and a shared, scope-aware ordinary-identifier namespace.
- **B4:** `collectStructs` (`src/language/parse/structs.js`) preloads later definitions; `requireCompleteAt` is applied to object declarations but not every expression/type use. Enforce visibility and completeness at the source position, including unevaluated expressions.
- **B5:** `parseNumberLiteral` in `src/language/parse/numberLiterals.js` calls storage conversion; `convertNumber` uses `BigInt.asUintN` for unsigned values. Validate literal representability before conversion. Preserve ordinary unsigned arithmetic wraparound, which passes the 32-bit control probe (but see B9 for 64-bit).
- **B6:** `binary` inside `checkProgram` (`src/language/checker.js`) allows pointer arithmetic without checking pointee completeness. `sizeof` suppresses evaluation, so the later runtime rejection never happens.
- **B7:** Tree-sitter's `null` token, which covers both `nullptr` and `NULL`, becomes `NullLiteral` in `parseExpression` (`src/language/parse/expressions.js`); both checker and interpreter treat it as `int`. Either reject `nullptr` explicitly in the C11 subset or implement its C23 type throughout. Current partial acceptance is misleading in either mode. **`NULL` extension:** `int n=NULL;` is accepted and `sizeof(NULL)` is 4. Defining `NULL` as the integer constant `0` is permitted (7.21p4: an "implementation-defined null pointer constant") and documented in the [language contract](SUPPORTED_C.md), so this is not a conformance defect. However, under glibc (`((void*)0)`), which the project otherwise mirrors for `printf`, the first is a constraint violation and the second is 8. The probes `B7-NULL-*` record the glibc expectation. Decide the `NULL` model together with the `nullptr` fix.
- **B8:** Temporary-member extraction in the `Member` case of `evaluateExpression` (`src/machine/execution/expressions.js`) bypasses the dangling-pointer check in `loadLValue` (`src/machine/execution/lvalues.js`). Centralize pointer-value validity checks across ordinary and temporary member reads.
- **B9:** `convertNumber` in `src/language/numeric.js` wraps unsigned results correctly with `BigInt.asUintN`, then rejects any result above `Number.MAX_SAFE_INTEGER` because values are stored as JavaScript numbers. Every `unsigned long`/`size_t` value at or above 2^53 is therefore unrepresentable, including all wraparound results. The language contract states that "unsigned arithmetic wraps to its type width", and the original control (`0U-1U`) only exercised 32-bit `unsigned int`. The diagnostic is not silent, but it attributes ordinary defined behavior to a resource limit. It also prevents demonstrating the classic `for (size_t i = n-1; i < n; i--)` countdown idiom and `size_t` underflow bugs. Store 64-bit integer values as `BigInt` (or an exact pair) through snapshots and visualization, or, as an interim measure, correct the language contract and classify the diagnostic as a simulator limit.

- **B10:** The `true`/`false` case of `parseExpression` (`src/language/parse/expressions.js`) builds an `int` `IntLiteral`, following C11 `<stdbool.h>`. C23 makes them keywords naming `bool` constants, so `sizeof(true)` is 1, and `_Generic` or `typeof` would observe `bool`. Give them type `bool`; arithmetic is unchanged because `bool` promotes to `int`. Found while planning the C23 migration; GCC 13 (`-std=c2x`) confirms the expected value.

B8 reproducer:

```c
#include <stdlib.h>
struct S { int *p; };
struct S f(void) {
    int x;
    struct S s={&x};
    return s;
}
int main(void) {
    int result=f().p==NULL;
}
```

Storing the returned struct first and then reading `s.p` triggers the existing diagnostic; reading `f().p` directly bypasses it. No native expected result is assigned to this UB probe.

## Subset limitations, distinguished from the findings above

These are accepted as limitations for a teaching subset, but must not be presented as invalid C.

| Group | Reproduced restriction | Relevant clauses |
| --- | --- | --- |
| L1: arrays | `int a[1+2]` rejected despite literal-only `int a[3]` working. (`int f(int a[])` was rejected at the original audit; now accepted.) | 6.6, 6.7.6.2, 6.7.6.3p6 |
| L2: type spellings | `long int`, `short int`, `signed int`, and `unsigned` rejected | 6.7.2p2 |
| L3: pointer types | `struct Missing *p=0` requires a later definition; `void *p` is rejected | 6.2.5, 6.3.2.3, 6.7.2.3 |
| L4: discarded results | `int f(void){}` followed by `f();` rejected | 6.9.1p12 |
| L5: C23 additions | Empty initialization of sized arrays and of scalars (`int x={};`), binary literals, and digit separators rejected. (`bool` now accepted.) | 6.7.10, 6.4.4.1 |
| L6: resource/representation limits | 65-element array and exact `long` value 9007199254740993 rejected. (See B9 for the unsigned consequence.) | Project-specific limits in `limits.js` and `numeric.js` |
| L7: undocumented operators and initializers | Bitwise `&`, `\|`, `^`, `~`, `<<`, `>>` (and compound forms), the comma operator, and designated initializers (`{[2]=5}`) rejected. None of these is listed as supported or unsupported in the language contract. | 6.5.3.3, 6.5.7, 6.5.10–6.5.12, 6.5.17, 6.7.10 |

The [language contract](SUPPORTED_C.md) additionally documents omitted casts, qualifiers, globals, prototypes, preprocessing, string literals outside `printf` and char-array initialization, unions, VLAs, the ternary operator, several numeric types, and library functions including `calloc`/`realloc`. L7 should be added to that list. This audit does not enumerate every unsupported C grammar production or library function. Empty initialization of an **unknown-size** array is a different case from the sized-array probe and remains invalid under N3088 6.7.10p4.

LP64 sizes, signed `char`, padding, deterministic operand order where order is unspecified, and retaining expired objects for inspection are model choices, not automatically defects. Always-successful allocation explores only the success path. Generated-C restrictions such as requiring a single live `main` frame are serialization limitations, not C constraints.

Rejections examined in the revision and found **correct**: `NULL + 0` (6.5.6p9 requires the pointer operand to point into an array object, so null-pointer arithmetic remains undefined in N3088; only a later draft defines it) and floating `1.0/0.0` (undefined without Annex F, which the project does not claim).

## Verification and scope

Original audit (2026-09-20):

- Executed the existing suites: 22 core cases, 23 round-trip cases, and 228 Node test cases. The initially skipped native test was subsequently run successfully through Ubuntu WSL: **273 existing checks passed in total**, including comparison of **89 defined-behavior fixtures** with GCC 9.4 and UBSan.
- Ran all 51 original probes through the current parser, checker, and interpreter: 41 discrepancies/limitations, 10 matches.
- Cross-checked 40 C11-compatible probes using GCC 9.4: strict `-std=c11 -pedantic-errors -fsyntax-only` checks, followed by UBSan execution and result assertions for accepted programs. Constraint-violation examples were compiled only; UB examples were not run natively.
- Clang 10 independently checked the earlier 39-probe native set, including the disputed constant-expression case. GCC 9 accepts that source without instrumentation but misclassifies it when UBSan and strict diagnostics are combined. The final tool separates strict syntax checking from instrumentation to avoid that interference.

Revision (2026-10-13, commit `1d7ee21`):

- `npm test`: 414 tests, 413 passed, 1 skipped (the native suite, which requires a configured compiler).
- All **69 probes**: **50 discrepancies/limitations, 19 matches**. Every original finding still reproduces except the two resolved rows noted above. All cited source files and functions still exist after the module split.
- `--native` (GCC 9.4 via Ubuntu 20.04 WSL): **51 C11-compatible probes** passed strict checking and UBSan execution.
- An exploratory set of 90 further probes (integer division/shift/promotion rules, unevaluated operands, indeterminate values, pointer provenance, function calls, initialization, scope, strings and `printf`) was cross-checked against GCC 9.4; their expectations all agreed with native results. Only the discrepancies above and representative controls were merged into the tool.

C23 groundwork (2026-10-13, after the revision):

- The language contract now targets C23, documents implementation choices, and lists known deviations. Every rejection carries a diagnostic category (not valid C, undefined behavior, not supported, PointerViz limit); `test/diagnostics.test.js` covers each category, and the probe output records it as `kind`.
- `--native` now requires a C23-capable compiler and checks every native-compatible probe as C23, plus C11-compatible probes as C11. With GCC 13.3 (`-std=c2x`) on Ubuntu 24.04 WSL: **51 probes passed as C11 and 60 as C23**, including the C23-only expectations (B7, B10, L5). The existing 89-fixture native suite also passes on GCC 13.3.

Common to all passes:

- Clauses cited by the revision were checked against the N3088 text: 6.2.5p11, 6.3.1.3p2, 6.3.2.3p7, 6.4.4p2, 6.5.6p9, 6.7.10p12, 7.21p4 and 7.24.3p1.
- C23-only cases were checked against N3088 and, since the C23 groundwork, against GCC 13. Neither native success nor sanitizer silence establishes general ISO conformance.
- Scope: parser, type checking, numeric evaluation, allocation, pointer operations, initialization, lifetime behavior, and (in the revision) string literals and `printf`. Existing memory, grading, generation, and presentation tests were rerun; browser interaction and every possible generated program were not independently audited.

Reproduce from the repository root:

```text
node test/audit-n3088.mjs
```

Optional native verification on this Windows workspace (needs GCC 13 or newer; GCC 9 in Ubuntu 20.04 is rejected because its `-std=c2x` lacks most of C23):

```powershell
$env:POINTERVIZ_WSL_DISTRO='Ubuntu-24.04'
node test/audit-n3088.mjs --native
```

Each JSON line records an independent expectation and observed outcome, with the diagnostic category of each rejection. The script reports discrepancies without making them passing regression expectations or adding them to `npm test`. Its successful exit means the audit ran, not that the interpreter conforms. `--native` fails if the native cross-check cannot be completed, including when the compiler lacks C23 support.

## Recommended order

1. ~~Make the supported language version and diagnostic categories explicit~~ (done in the C23 groundwork).
2. ~~Fix misleading accepted results: B10, B5, B3, B7 (including the `NULL` decision), B4/B6/B8~~ (done in Phase 1, except B3's tag identity). B9 remains; the contract flags it as a limit.
3. ~~Fix B1/B2~~ (Phase 2); normalize equivalent type spellings (L2, Phase 3).
4. ~~Redesign allocation storage for A1, integrating A2/A3, the C23 alignment policy, and general `void *` conversions~~ (Phase 2), together with B9's exact 64-bit integers.
5. Document L7 in the language contract. Decide which C23 additions to implement.

The audit itself adds only the report and reproduction tool. The later C23 groundwork changed diagnostics (each now carries a category) but no program results; Phase 1 changed program results as listed in its status table.
