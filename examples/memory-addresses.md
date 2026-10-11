# Exploring simulated addresses

Paste an example into Sandbox, Run, then step through it. Start with Both and select names/member labels for the inspector. Addresses are deterministic within this teaching model; native C can place objects differently.

## Aliases, pointer-to-pointer, array stride, and one-past

```c
int main(void) {
    int a[3] = {10, 20, 30};
    int *p = &a[1];
    int *alias = p;
    int **pp = &p;
    int *end = a + 3;
    p++;
    return 0;
}
```

`a` starts at `0x10000000`; its elements occupy addresses `0x10000000`, `0x10000004`, and `0x10000008`. Initially p and alias both store `0x10000004`, but their own addresses differ. pp stores p's own address, `0x10010000`; `*pp` is the pointer value stored in p. Incrementing p advances its stored address by 4 bytes without moving p or alias. end stores `0x1000000c`, the one-past boundary. It cannot be dereferenced. Show boundary opens the boundary inspector.

## Struct alignment and padding

```c
struct Record {
    char tag;
    int count;
    char ready;
};
int main(void) {
    struct Record r = {'A', 7, 1};
    int *p = &r.count;
    struct Record *whole = &r;
    return 0;
}
```

r is 12 bytes. Its fields start at offsets 0, 4, and 8. The model includes 3 bytes of padding before count and 3 bytes at the end. r and r.tag share a numeric address but have different types and paths. The typed picker offers only compatible targets; a matching number does not make those references interchangeable.

## Freed storage and dangling aliases

```c
int main(void) {
    int *p = malloc(sizeof(int));
    *p = 42;
    int *alias = p;
    free(p);
    int *q = malloc(sizeof(int));
    *q = 9;
    return 0;
}
```

p and alias retain the former address `0x80000000` after free and are labeled dangling. Their inspector refuses to display a dereferenced value. q receives `0x80010000`: a later allocation never revives a stale pointer. The large gap reserves room for diagram edits; it is not the allocated object's size or a native allocator simulation.

## Returned stack storage

```c
int *temporary(void) {
    int x = 7;
    return &x;
}
int main(void) {
    int *p = temporary();
    return 0;
}
```

After temporary returns, p identifies an expired object. Inspect p and select Show next to its target to reveal x and its returned frame. The old address is historical information, not permission to dereference it.

Out-of-bounds arithmetic remains an execution error. For example, replacing `a + 3` in the first program with `a + 4` is rejected; PointerViz does not search other objects for a matching numeric address. Entering raw addresses into pointers is outside this implementation.
