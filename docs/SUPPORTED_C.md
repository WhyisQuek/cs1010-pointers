# PointerViz Mini-C language contract

PointerViz supports a bounded C11 subset for pointer-learning exercises. It uses an explicit LP64 implementation model, not the host machine's ABI. Unsupported constructs are diagnosed; this is not a complete C compiler. See [the semantic audit](C_SEMANTICS_AUDIT.md) for tested behavior and remaining limits.

## Types

Supported:

- `char`, `short`, `int`, `long`, `unsigned int`, `unsigned long`, `float`, `double`;
- `bool` (also spelled `_Bool`) with the constants `true` and `false`;
- `size_t`;
- pointers of arbitrary depth;
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

`bool`, `true`, `false` and `size_t` are predefined, as if `<stdbool.h>` and `<stddef.h>` were included (`#include` lines are accepted and ignored). `size_t` is the LP64 typedef of `unsigned long`: the two are the same type, so a `size_t *` may point to an `unsigned long`, but declarations keep the `size_t` spelling in the diagram and generated C.

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

An array may contain at most **64 elements**. Heap allocations are also limited to 64 logical elements.

Array members and subarrays decay to their first element. Pointer arithmetic preserves the innermost array boundary: an adjacent row is not an extension of the current row. Pointer-to-array declarators and `i[a]` are supported. `&a[n]` may form a one-past pointer, and `&*p` cancels the dereference even for null/one-past pointers.

## Dynamic memory

Supported:

- `malloc` when the destination/expected pointer type is known;
- heap arrays through `malloc(n * sizeof(T))`;
- `free`;
- `free(NULL)` / `free(0)`;
- double-free detection;
- rejection of freeing stack/interior pointers;
- dangling aliases after `free`.

`free` returns `void`. A dangling pointer remains visible as diagnostic history; evaluating it again is rejected (a repeated `free` reports double free). `malloc` always succeeds within the configured limits and requires a positive multiple of the destination element size. Zero-size allocation, allocation failure, effective-type changes and allocation through a pointer-to-array destination are not modeled.

## Expressions

Supported:

- assignment and compound assignment;
- `&` and `*`;
- integer and floating `+ - * /`, and integer `%`;
- comparisons and logical operators listed above;
- supported pointer arithmetic;
- `sizeof(type)` and unevaluated, type-checked `sizeof(expression)`;
- character and integer literals;
- `NULL` and zero as null pointer constants in pointer context.

`NULL` is predefined as integer constant `0`. A variable whose value happens to be zero is not a null pointer constant. `sizeof` returns an unsigned-long `size_t`; pointer subtraction returns signed-long `ptrdiff_t`. Character constants have type `int`. As in C11 `<stdbool.h>`, `true` and `false` are the integer constants `1` and `0`.

Converting any number or pointer to `bool` yields `1` if it compares unequal to zero and `0` otherwise (`bool b = 256;` and `bool b = p;` are both `true`); it never truncates. `bool` operands promote to `int`, so `b++` leaves `true` and `b--` toggles. The diagram shows stored `bool` values as `true`/`false`.

Integer promotions and usual arithmetic conversions apply to the supported types. Integer division truncates toward zero; floating division retains fractions. Signed arithmetic overflow and invalid floating-to-integer conversions are diagnosed. Unsigned arithmetic wraps to its type width. The implementation chooses signed 8-bit `char` and two's-complement signed narrowing. Float storage and operations round to binary32; double uses binary64. Exact integer intermediates beyond JavaScript's safe integer range are rejected, even if a native 64-bit C implementation could represent them.

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
| Struct fields | 32 |
| Call depth | 32 |
| Iterations per loop | 256 |
| Visualized statements | 500 |
| Total scalar subobjects per allocation | 4096 |
| Program output characters | 10000 |

A loop that exceeds 256 iterations is stopped with an error. This prevents accidental infinite loops from freezing the page.

## Other unsupported C features

- casts and general `void *` conversions;
- `calloc`, `realloc`;
- macros and real preprocessing;
- standard-library calls other than `malloc`, `free` and `printf`;
- string literals outside `printf` and other C string semantics;
- VLAs;
- `long long`, unsigned char/short, long double, wide/multicharacter constants and hexadecimal floating literals;
- complete undefined-behavior analysis, implementation-defined behavior across other ABIs, floating environments, infinities and NaNs.

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
