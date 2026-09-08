# PointerViz Mini-C language contract

PointerViz supports the C constructs needed for pointer-learning exercises. Unsupported syntax fails explicitly instead of being approximated.

## Types

Supported:

- `char`, `short`, `int`, `long`, `float`, `double`;
- pointers of arbitrary depth;
- fixed-size arrays;
- named `struct` types;
- self-referential struct pointers.

Example:

```c
struct Node {
    int value;
    struct Node *next;
};
```

Not supported: anonymous structs, unions, enums, bitfields and function pointers.

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

`&&` and `||` short-circuit. Relational pointer comparison is limited to pointers within the same array/allocation.

Not supported: `do ... while`, `switch`, `goto` and the ternary operator.

## Structures

Supported:

- named struct declarations;
- struct variables and aggregate initialization;
- `.` and `->` member access;
- taking the address of a field;
- pointers between structures;
- `malloc(sizeof(struct T))`;
- `sizeof(struct T)`.

PointerViz models struct size as the sum of field sizes. ABI padding is intentionally omitted.

## Arrays

Supported:

- fixed-size declarations and initializer lists;
- array-to-pointer decay;
- `arr[i]`, `p[i]`, `&arr[i]`;
- pointer `+`, `-`, `++`, `--` within one allocation;
- one-past pointers, which cannot be dereferenced.

An array may contain at most **64 elements**. Heap allocations are also limited to 64 logical elements.

## Dynamic memory

Supported:

- `malloc` when the destination/expected pointer type is known;
- heap arrays through `malloc(n * sizeof(T))`;
- `free`;
- `free(NULL)` / `free(0)`;
- double-free detection;
- rejection of freeing stack/interior pointers;
- dangling aliases after `free`.

## Expressions

Supported:

- assignment and compound assignment;
- `&` and `*`;
- integer `+ - * / %`;
- comparisons and logical operators listed above;
- supported pointer arithmetic;
- `sizeof(type)` and common `sizeof(expression)` cases;
- character and integer literals;
- `NULL` and zero as null pointer constants in pointer context.

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

A loop that exceeds 256 iterations is stopped with an error. This prevents accidental infinite loops from freezing the page.

## Other unsupported C features

- casts and general `void *` conversions;
- `calloc`, `realloc`;
- macros and real preprocessing;
- arbitrary standard-library calls;
- complete C string semantics;
- VLAs;
- complete integer-promotion, overflow and undefined-behaviour emulation.

## Teaching-machine sizes

| Type | Size |
|---|---:|
| `char` | 1 |
| `short` | 2 |
| `int` | 4 |
| `long` | 8 |
| `float` | 4 |
| `double` | 8 |
| pointer | 8 |
