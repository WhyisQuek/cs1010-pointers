# C behavior audit against N3088

Date: 2026-09-20. Audited the current working tree, including existing local edits, based on commit `3160cc2`. Application behavior was not changed by this audit.

Reference: [WG14 N3088](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf), the requested C23 draft. The project currently advertises a bounded **C11 subset**. The earlier [C11 audit](C_SEMANTICS_AUDIT.md) remains historical evidence, not a C23 conformance claim.

The audit found **11 groups of behavioral discrepancies**, plus **6 groups of subset limitations**. The accompanying [reproduction tool](../test/audit-n3088.mjs) contains 51 probes: 41 expose these discrepancies/limitations; 10 are working controls. These are targeted examples, not 41 independent defects or a statistical conformance score.

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

Allocation and pointer assignment are allowed; accessing an `int` needs sufficient storage. N3088: [6.3.2.3p1, 7.24.3p1, 7.24.3.6](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf#page=378). In this project's four-byte `int` model, `*a = 42` would exceed a one-byte allocation. The declaration itself is not that access.

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

Recommended design: store requested byte length and allocation identity independently of the pointer's type; represent pointer views separately; check access width, alignment, lifetime, and effective type when accessing memory. Define a zero-size policy and optional allocation-failure mode. Carry byte sizes through snapshots, visualization, validation, grading, and generated C.

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
| B5 / High | `unsigned long n=18446744073709551616UL;` | Silently produces **0**; `malloc(18446744073709551617UL)` allocates one byte | Literal must fit a supported candidate type; 6.4.4.1p6 |
| B6 / Medium | `sizeof(malloc(4)+1)` | Accepts and produces 8 | Invalid `void *` arithmetic; 6.5.6p2 |
| B7 / High | `sizeof(nullptr)`; `int n=nullptr;`; `nullptr+1` | Produces 4, 0, and 1 respectively | Distinct non-arithmetic type; pointer-sized here; 6.4.4.5, 7.21.2 |
| B8 / Medium | Returned-struct example below | Completes comparison and produces 0 | Dangling-pointer use is UB; 6.2.4p2 |

Clause references in this table are to [N3088](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf). B5 is assessed against the project's declared integer types; the audit does not assume that every C implementation lacks wider extended types. B8 concerns the project's promised diagnostic coverage: ISO C does not require a diagnostic for every UB execution.

Root causes and repair directions:

- **B1:** `evalExpression` in `src/machine/execution/expressions.js` overwrites `integerConstant` on the outer `InitializerList`, losing the inner zero's classification. Preserve the scalar initializer's constant-expression information.
- **B2:** `constant` inside `checkProgram` (`src/language/checker.js`) evaluates both binary operands before handling `&&`/`||`. Keep checking both operands' constraints, but evaluate only the required operand values. Runtime short-circuiting already works.
- **B3:** The `sizeof_expression` case of `parseExpression` (`src/language/parse/expressions.js`) consults a global alias registry instead of lexical visibility. The same registry also conflates an anonymous struct's synthetic name with a real tag: `typedef struct {int x;} S; struct S{long y;};` is rejected. Conversely, a typedef and a function named `S` in the same scope are accepted. Use separate tag identities and a shared, scope-aware ordinary-identifier namespace.
- **B4:** `collectStructs` (`src/language/parse/structs.js`) preloads later definitions; `requireCompleteAt` is applied to object declarations but not every expression/type use. Enforce visibility and completeness at the source position, including unevaluated expressions.
- **B5:** `parseNumberLiteral` in `src/language/parse/numberLiterals.js` calls storage conversion; `convertNumber` uses `BigInt.asUintN` for unsigned values. Validate literal representability before conversion. Preserve ordinary unsigned arithmetic wraparound, which passes the control probe.
- **B6:** `binary` inside `checkProgram` (`src/language/checker.js`) allows pointer arithmetic without checking pointee completeness. `sizeof` suppresses evaluation, so the later runtime rejection never happens.
- **B7:** Tree-sitter's `null` token becomes `NullLiteral` in `parseExpression` (`src/language/parse/expressions.js`); both checker and interpreter treat it as `int`. Either reject `nullptr` explicitly in the C11 subset or implement its C23 type throughout. Current partial acceptance is misleading in either mode.
- **B8:** Temporary-member extraction in the `Member` case of `evaluateExpression` (`src/machine/execution/expressions.js`) bypasses the dangling-pointer check in `loadLValue` (`src/machine/execution/lvalues.js`). Centralize pointer-value validity checks across ordinary and temporary member reads.

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
| L1: arrays | `int a[1+2]` rejected despite literal-only `int a[3]` working; `int f(int a[])` rejected despite `int f(int a[3])` working | 6.6, 6.7.6.2, 6.7.6.3p6 |
| L2: type spellings | `long int`, `short int`, `signed int`, and `unsigned` rejected | 6.7.2p2 |
| L3: pointer types | `struct Missing *p=0` requires a later definition; `void *p` is rejected | 6.2.5, 6.3.2.3, 6.7.2.3 |
| L4: discarded results | `int f(void){}` followed by `f();` rejected | 6.9.1p12 |
| L5: C23 additions | Empty initialization of sized arrays, `bool`, binary literals, and digit separators rejected | 6.7.10, 6.7.2, 6.4.4.1 |
| L6: resource/representation limits | 65-element array and exact `long` value 9007199254740993 rejected | Project-specific limits in `limits.js` and `numeric.js` |

The [language contract](SUPPORTED_C.md) additionally documents omitted casts, qualifiers, globals, prototypes, preprocessing, strings, unions, VLAs, several numeric types, and library functions including `calloc`/`realloc`. This audit does not enumerate every unsupported C grammar production or library function. Empty initialization of an **unknown-size** array is a different case from the sized-array probe and remains invalid under N3088 6.7.10p4.

LP64 sizes, signed `char`, padding, deterministic operand order where order is unspecified, and retaining expired objects for inspection are model choices, not automatically defects. Always-successful allocation explores only the success path. Generated-C restrictions such as requiring a single live `main` frame are serialization limitations, not C constraints.

## Verification and scope

- Executed the existing suites: 22 core cases, 23 round-trip cases, and 228 Node test cases. The initially skipped native test was subsequently run successfully through Ubuntu WSL: **273 existing checks passed in total**, including comparison of **89 defined-behavior fixtures** with GCC 9.4 and UBSan.
- Ran all **51 new probes** through the current parser, checker, and interpreter: **41 discrepancies/limitations, 10 matches**.
- Cross-checked **40 C11-compatible probes** using GCC 9.4: strict `-std=c11 -pedantic-errors -fsyntax-only` checks, followed by UBSan execution and result assertions for accepted programs. Constraint-violation examples were compiled only; UB examples were not run natively.
- Clang 10 independently checked the earlier 39-probe native set, including the disputed constant-expression case. GCC 9 accepts that source without instrumentation but misclassifies it when UBSan and strict diagnostics are combined. The final tool separates strict syntax checking from instrumentation to avoid that interference.
- C23-only cases were checked against N3088, not these older compilers. Neither native success nor sanitizer silence establishes general ISO conformance.
- Scope: parser, type checking, numeric evaluation, allocation, pointer operations, initialization, and lifetime behavior. Existing memory, grading, generation, and presentation tests were rerun; browser interaction and every possible generated program were not independently audited.

Reproduce from the repository root:

```text
node test/audit-n3088.mjs
```

Optional native verification on this Windows workspace:

```powershell
$env:POINTERVIZ_WSL_DISTRO='Ubuntu-20.04'
node test/audit-n3088.mjs --native
```

Each JSON line records an independent expectation and observed outcome. The script reports discrepancies without making them passing regression expectations or adding them to `npm test`. Its successful exit means the audit ran, not that the interpreter conforms. `--native` fails if the native cross-check cannot be completed.

## Recommended order

1. Fix misleading accepted results first: B3, B5, B7, then B4/B6/B8.
2. Fix B1/B2 and normalize equivalent type spellings and array parameters.
3. Redesign allocation storage for A1, integrating A2/A3 and general `void *` conversions. Add access-boundary tests before relaxing allocation checks.
4. Make the supported language version and diagnostic categories explicit: constraint violation, runtime UB, unsupported feature, and simulator resource limit. Decide which C23 additions to implement.

This audit adds the report and reproduction tool only. The pre-existing working-tree changes and all application semantics are preserved.
