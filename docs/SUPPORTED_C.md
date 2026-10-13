# PointerViz Mini-C language contract

PointerViz supports a bounded subset of **C23** ([ISO/IEC 9899:2024](https://www.iso.org/standard/82075.html), working draft [N3088](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n3088.pdf)) for pointer-learning exercises. It uses an explicit LP64 implementation model, not the host machine's ABI ([Implementation choices](#implementation-choices)). Unsupported constructs are diagnosed; this is not a complete C compiler.

The goal is that every program PointerViz accepts behaves as C23 specifies under that model, and every program it rejects says why ([Diagnostics](#diagnostics)). The subset was originally built against C11, and some behavior still differs from C23: see [Known deviations from C23](#known-deviations-from-c23) and [the N3088 audit](C_SPEC_AUDIT_N3088.md). The earlier [C11 semantic audit](C_SEMANTICS_AUDIT.md) records the tested C11 behavior.

## Diagnostics

Every rejected program is labeled with one category:

| Label | Meaning |
|---|---|
| **Not valid C** | A syntax error or constraint violation. Any conforming C23 compiler must reject it. |
| **Undefined behavior** | Valid C whose execution (or, for `printf` formats and arguments, whose call) has undefined behavior. PointerViz stops instead of continuing with meaningless results. |
| **Not supported by PointerViz** | Valid C outside this subset, such as `const`, bitwise operators or `typeof`. A real compiler would accept it. |
| **PointerViz limit** | Valid C that exceeds a browser-safety or representation limit ([Safety limits](#safety-limits)). |
| **PointerViz error** | A defect in PointerViz itself, not in the program. Please report it. |

When a rule is only partly modeled, the diagnostic errs toward **Not supported**, so valid C is not presented as invalid. A few known defects still mislabel valid C (for example a braced null pointer initializer, `int *p = {0};`); they are tracked in [the N3088 audit](C_SPEC_AUDIT_N3088.md).

## Types

Supported:

- `char`, `short`, `int`, `long`, `unsigned int`, `unsigned long`, `float`, `double`;
- `bool` (also spelled `_Bool`) with the constants `true` and `false`;
- `size_t`;
- pointers of arbitrary depth, including `void *`;
- fixed-size arrays;
- named `struct` types;
- direct struct typedefs, including anonymous definitions;
- self-referential struct pointers.

Example:

```c
typedef struct Node {
    int value;
    struct Node *next;
} Node;

/* Use the typedef name for objects and pointers. */
Node a;
Node *p;
```

`bool`, `true` and `false` are keywords, as in C23, and `size_t` is predefined as if `<stddef.h>` were included (`#include` lines are accepted and ignored). `size_t` is the LP64 typedef of `unsigned long`: the two are the same type, so a `size_t *` may point to an `unsigned long`, but declarations keep the `size_t` spelling in the diagram and generated C.

`typedef struct { int value; } Node;` and a forward `typedef struct Node Node;` are also supported. A self-reference inside the typedef definition uses `struct Node *next`, because the alias is declared after the body. Existing `struct Node a;` declarations remain valid C.

Not supported: anonymous structs without a typedef, general non-struct typedefs, unions, enums, bitfields and function pointers.

## Functions and scopes

Supported:

- multiple user-defined functions;
- named parameters;
- primitive, pointer and struct parameters/returns;
- nested calls and recursion;
- local variables;
- lexical block scopes;
- separate call-stack frames;
- dangling pointers to storage whose scope/frame has ended.

Each function call creates a frame. Returned frames and expired stack allocations remain in the teaching state as inactive/dead objects so dangling-pointer provenance can be shown.

Functions must be defined before use (self-recursion is supported). The entry point is `int main(void)` or `int main()`. Function prototypes, global variables, storage classes, qualifiers, variadic functions and block-scoped type definitions are outside this subset. Constraints are checked in every function and branch before execution, including unreachable statements.

## Control flow

Supported:

```c
if (condition) { ... }
else { ... }

while (condition) { ... }

for (initializer; condition; update) { ... }
```

Also supported:

- `else if`;
- declaration or expression initializers in `for`;
- omitted `for` initializer, condition or update;
- `break` and `continue`;
- empty statements;
- block-local declarations.

Conditions use C-style scalar truth values: zero/`NULL` is false; non-zero numbers and concrete pointers are true.

Useful condition/expression operators include:

- `==`, `!=`, `<`, `<=`, `>`, `>=`;
- `&&`, `||`, `!`;
- `+=`, `-=`, `*=`, `/=`, `%=`;
- prefix/postfix `++` and `--`.

`&&` and `||` short-circuit. Relational pointer comparison supports the same array, a scalar treated as an array of one, and direct members of the same struct. Unrelated allocations cannot be ordered. Conflicting unsequenced scalar accesses are diagnosed, including aliased accesses and function arguments.

Not supported: `do ... while`, `switch`, `goto` and the ternary operator.

## Structures

Supported:

- named struct declarations;
- struct variables and aggregate initialization;
- `.` and `->` member access;
- taking the address of a field;
- pointers between structures;
- `malloc(sizeof(struct T))`;
- `sizeof(struct T)` and `sizeof(T)` for a struct typedef.

Struct definitions and typedefs must be at file scope. Struct sizes include LP64 member alignment and tail padding. A struct containing `char`, `int`, `char` therefore occupies 12 bytes. Struct copies, scalar members of returned structs, partial initialization and brace elision are supported.

## Arrays

Supported:

- fixed-size declarations, multidimensional arrays, initializer lists and brace elision;
- array-to-pointer decay;
- `arr[i]`, `p[i]`, `&arr[i]`;
- pointer `+`, `-`, `++`, `--` within the same array, including scalar objects treated as arrays of one;
- one-past pointers, which cannot be dereferenced.

An array may contain at most **64 elements**. Heap allocations are also limited to 64 logical elements. `= {}` initializes an array, struct or scalar to zero (or null pointers), as in C23; it cannot give an array of unknown size its length. A single scalar initializer may be braced, as in `int *p = {0};`.

Array members and subarrays decay to their first element. Pointer arithmetic preserves the innermost array boundary: an adjacent row is not an extension of the current row. Pointer-to-array declarators and `i[a]` are supported. `&a[n]` may form a one-past pointer, and `&*p` cancels the dereference even for null/one-past pointers.

## Dynamic memory

Supported:

- `malloc` anywhere an expression may appear, including discarded results, `free(malloc(n))` and comparisons;
- heap arrays through `malloc(n * sizeof(T))`, including pointer-to-array destinations;
- `void *` holding any object pointer, and converting back to the original type;
- `free`, through any pointer to the start of the block (for example a pointer to its first struct member);
- `free(NULL)` / `free(0)`;
- double-free detection;
- rejection of freeing stack/interior pointers;
- dangling aliases after `free`.

`malloc` returns a `void *` to an **untyped block** of the requested size, shown in the diagram as an `n-byte block`. The size may be any arithmetic value; it converts to `size_t`. The block takes a type the first time a pointer to it is converted to `T *` (C23's effective-type rule, 6.5p6). It then holds as many whole `T` objects as fit, so `malloc(5)` converted to `int *` holds one `int` and one unused byte. If not even one `T` fits, the block stays untyped and dereferencing the pointer is undefined behavior. A `void *` converted back to `T *` designates the `T` object at that address. Reading an object through a pointer to a different type is diagnosed: as undefined behavior in general, or as not supported for the cases C allows but PointerViz does not model (character access, and the signed/unsigned twin of the type).

`free` returns `void`. A dangling pointer remains visible as diagnostic history; evaluating it again is rejected (a repeated `free` reports double free). `malloc` always succeeds within the configured limits, and `malloc(0)` returns `NULL` ([Implementation choices](#implementation-choices)). Allocation failure is not simulated, so a program never sees `malloc` return `NULL` for a nonzero size. **Generate C** cannot yet reproduce a heap block reached only through a pointer to a whole array (`int (*p)[2] = malloc(...)`); such programs still run and display normally.

## Expressions

Supported:

- assignment and compound assignment;
- `&` and `*`;
- integer and floating `+ - * /`, and integer `%`;
- comparisons and logical operators listed above;
- supported pointer arithmetic;
- `sizeof(type)` and unevaluated, type-checked `sizeof(expression)`;
- character and integer literals;
- `NULL`, zero and `nullptr` as null pointer constants in pointer context.

`NULL`, `malloc`, `free` and `printf` are reserved: they cannot name a function, variable or parameter, in code or in a diagram. (C reserves the library functions as external names; PointerViz also forbids them as local names so every program state can be regenerated as C.) A diagram variable also cannot reuse a struct typedef name.

`NULL` is predefined as integer constant `0`. A variable whose value happens to be zero is not a null pointer constant. `sizeof` returns an unsigned-long `size_t`; pointer subtraction returns signed-long `ptrdiff_t`. Character constants have type `int`. `true` and `false` are constants of type `bool` (so `sizeof(true)` is 1); they promote to `int` in arithmetic. Because they are not integer constants, `int *p = false;` is invalid, as in C23.

C23's `nullptr` is supported as an expression. It has type `nullptr_t`, which is the size of a pointer (`sizeof(nullptr)` is 8). It converts only to a pointer type or `bool`, compares equal to null pointers, `0` and itself, and cannot be used in arithmetic or ordered comparisons. `printf("%p", nullptr)` prints `(nil)`. Declaring an object of type `nullptr_t` is not supported.

Integer constants take the first type in C23's list for their suffix that can represent the value (for example, `2147483648` is a `long` and `0x80000000` is an `unsigned int`). A constant too large for every type in its list is invalid.

A struct is incomplete until its definition: `sizeof`, member access and pointer arithmetic need the definition to appear earlier in the file, although a pointer to the struct may be declared before it, or to a struct that is never defined. Arithmetic on a `void *` is invalid. A function that ends without `return` may be called for its effects; only using its missing value is diagnosed. Inside `&&` and `||`, a constant expression never evaluates the operand that is skipped, so `int *p = 0 && (1/0);` is a null pointer. A local variable or parameter with the same name as a typedef hides the typedef inside its scope, so `sizeof(S)` then measures the variable; a typedef and a function cannot share a name.

Converting any number or pointer to `bool` yields `1` if it compares unequal to zero and `0` otherwise (`bool b = 256;` and `bool b = p;` are both `true`); it never truncates. `bool` operands promote to `int`, so `b++` leaves `true` and `b--` toggles. The diagram shows stored `bool` values as `true`/`false`.

Integer promotions and usual arithmetic conversions apply to the supported types. Integer division truncates toward zero; floating division retains fractions. Signed arithmetic overflow and invalid floating-to-integer conversions are diagnosed. Unsigned arithmetic wraps to its type width, including 64-bit `unsigned long` and `size_t` (`size_t n = 0; n--;` gives 18446744073709551615). All integer values are exact across the full 64-bit range. The implementation chooses signed 8-bit `char` and two's-complement signed narrowing. Float storage and operations round to binary32; double uses binary64.

## Output with `printf`

`printf` is predefined (`#include <stdio.h>` is optional and ignored) and prints to the **Output** pane under the code. During playback the pane shows what the program has printed up to the selected step. It returns the number of characters written.

```c
int a[3] = {4, 5, 6};
for (size_t i = 0; i < 3; i++)
    printf("a[%zu] = %d at %p\n", i, a[i], &a[i]);
```

The format must be a string literal (adjacent literals concatenate). Supported conversions:

| Conversion | Argument |
|---|---|
| `%d` `%i` | `int` (`%ld`: `long`, `%zd`: signed `size_t`) |
| `%u` `%x` `%X` `%o` | `unsigned int` (`%lu` etc.: `unsigned long`, `%zu`: `size_t`) |
| `%hhd` `%hd` and other `hh`/`h` forms | `int`, printed after narrowing to `char`/`short` |
| `%c` | `int` |
| `%f` `%F` `%e` `%E` `%g` `%G` (also `%lf`) | `double` |
| `%s` | `char *` (or a char array) ending in `'\0'`, or a string literal |
| `%p` | any object pointer |
| `%%` | none |

Flags `-`, `+`, space, `0` and `#`, field widths, precisions and `*` are supported. Arguments get the default promotions (`char`, `short` and `bool` become `int`; `float` becomes `double`). A signed argument may be printed with the matching unsigned conversion, and the reverse, only when its value fits both types.

Formatting matches glibc. Doubles print their exact decimal value, with ties rounded to even (`%.0f` of `2.5` is `2`). `%p` prints the simulated address shown in the diagram, and `(nil)` for `NULL`.

Diagnosed before running: a non-literal format, too few arguments, an argument type that does not match its conversion (like GCC's `-Wformat`), and unsupported conversions (`%n`, `%a`, `ll`/`j`/`t`/`L` lengths, wide `%lc`/`%ls`). Extra arguments are evaluated and ignored, as in C. At run time, `%s` is rejected if it would read past the array without finding `'\0'`, read an uninitialized char, or receive `NULL`. Output is limited to 10,000 characters. String literals are not supported anywhere else.

## Safety limits

PointerViz executes in the browser, so the semantic layer enforces limits even when source is entered directly:

| Limit | Value |
|---|---:|
| Array elements | 64 |
| Heap elements per allocation | 64 |
| Bytes requested by one `malloc` | 16384 |
| Struct fields | 32 |
| Call depth | 32 |
| Iterations per loop | 256 |
| Visualized statements | 500 |
| Total scalar subobjects per allocation | 4096 |
| Program output characters | 10000 |

A loop that exceeds 256 iterations is stopped with an error. This prevents accidental infinite loops from freezing the page.

## Other unsupported C features

- casts;
- `calloc`, `realloc`;
- macros and real preprocessing;
- standard-library calls other than `malloc`, `free` and `printf`;
- string literals outside `printf` and other C string semantics;
- VLAs;
- `long long`, unsigned char/short, long double, wide/multicharacter constants and hexadecimal floating literals;
- complete undefined-behavior analysis, implementation-defined behavior across other ABIs, floating environments, infinities and NaNs.

## Implementation choices

C23 leaves these to the implementation (Annex J.3 lists what an implementation must document). PointerViz makes the following choices; programs that depend on a different choice can behave differently with a native compiler.

| Behavior | PointerViz | C23 reference |
|---|---|---|
| Data model | LP64: sizes and alignments in [Teaching-machine sizes](#teaching-machine-sizes) | 6.2.5, 6.2.8 |
| Plain `char` | Signed, 8 bits, ASCII character set | 6.2.5p20, 5.2.1 |
| Integer representation | Two's complement, no padding bits (required by C23) | 6.2.6.2 |
| Conversion to a narrower signed type | Wraps modulo 2^N, keeping the low bits (`char c = 200;` gives `-56`) | 6.3.1.3p3 |
| `NULL` | The integer constant `0` (glibc instead uses `((void*)0)`) | 7.21p4 |
| `float`, `double` | IEEE 754 binary32 and binary64, round to nearest. Annex F is **not** claimed: infinities and NaNs are rejected, and floating division by zero is diagnosed as undefined behavior. | 5.2.4.2.2, Annex F |
| Struct layout | Members at natural alignment, tail padding to the largest member alignment | 6.7.2.1 |
| Order of evaluation | Operands and arguments are evaluated left to right. Where C leaves the order unspecified, conflicting unsequenced accesses are still diagnosed as undefined behavior. | 6.5p2–3, 6.5.2.2p8 |
| `malloc` | Every block is aligned to 16 bytes, the largest fundamental alignment, so converting its pointer to any object pointer type is defined. A nonzero request always succeeds within the [safety limits](#safety-limits). `malloc(0)` returns `NULL` (glibc instead returns a unique pointer). | 7.24.3p1 |
| Lifetime ends | Expired stack frames and freed blocks stay visible as dead objects; any use of a pointer to them is diagnosed | 6.2.4p2 |
| Optional features | Not provided: variable-length arrays, atomics, threads, complex numbers, decimal floating point | 6.10.9.3 (`__STDC_NO_VLA__` and related macros) |

## Known deviations from C23

These are defects or C11 behavior still to be changed, not implementation choices. Each is tracked in [the N3088 audit](C_SPEC_AUDIT_N3088.md).

- The name of an anonymous typedef'd struct cannot also be used as a struct tag (`typedef struct {int x;} S; struct S {...};`), although C keeps tags separate. This is rejected as not supported (audit B3).

## Teaching-machine sizes

Memory views use simulated byte addresses following these sizes and natural struct alignment/padding. Separate root objects occupy spaced reservations, so their displayed gaps are not native stack layout. Addresses are derived from typed references; they do not enable pointer casts, hardcoded address entry, `%p`, or cross-object pointer arithmetic. A pointer going beyond its permitted object/array boundary is rejected even if a numeric location could coincide with another object. A one-past value is labeled and cannot be dereferenced; an expired target is dangling.

| Type | Size |
|---|---:|
| `bool` | 1 |
| `char` | 1 |
| `short` | 2 |
| `int` | 4 |
| `unsigned int` | 4 |
| `long` | 8 |
| `unsigned long` / `size_t` | 8 |
| `float` | 4 |
| `double` | 8 |
| pointer | 8 |
