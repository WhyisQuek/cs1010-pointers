/**
 * Content for the Start here tutorial: the Try it programs, and the C that does and does not
 * work. Every program here is run by test/tutorial.test.js, so the tutorial cannot promise
 * something the interpreter has stopped doing, or warn about something it now supports.
 */

/** Programs that Try it loads into the sandbox. `fails` marks the one that stops with an error. */
export const EXAMPLES = Object.freeze([
  {
    id: 'swap',
    title: 'Swap with pointers',
    blurb: 'A function changes its caller’s variables through pointers.',
    code: `void swap(int *a, int *b) {
    int tmp = *a;
    *a = *b;
    *b = tmp;
}

int main(void) {
    int x = 1;
    int y = 2;
    swap(&x, &y);
    return 0;
}
`,
  },
  {
    id: 'arrays',
    title: 'Walk an array',
    blurb: 'A pointer moves along an array with ++ and +.',
    code: `int main(void) {
    int arr[4] = {10, 20, 30, 40};
    int *p = arr;
    p++;
    *p = 25;
    p = p + 2;
    *p = 45;
    return 0;
}
`,
  },
  {
    id: 'list',
    title: 'Build a linked list',
    blurb: 'malloc nodes onto the heap, link them, then free them.',
    code: `typedef struct Node {
    int value;
    struct Node *next;
} Node;

int main(void) {
    Node *head = NULL;
    for (int i = 3; i > 0; i--) {
        Node *n = malloc(sizeof(Node));
        n->value = i;
        n->next = head;
        head = n;
    }
    while (head != NULL) {
        Node *next = head->next;
        free(head);
        head = next;
    }
    return 0;
}
`,
  },
  {
    id: 'bug',
    title: 'Spot the bug',
    blurb: 'This one crashes. Step back to see why.',
    fails: true,
    code: `int *make_number(void) {
    int n = 42;
    return &n;
}

int main(void) {
    int *p = make_number();
    *p = 7;
    return 0;
}
`,
  },
]);

/** What works, each with a short sample for the page and a full program for the test. */
export const SUPPORTED = Object.freeze([
  {
    label: 'Basic types',
    sample: 'int  char  double  bool',
    code: `int main(void) {
    int i = 1;
    char c = 'a';
    double d = 1.5;
    bool b = true;
    size_t n = sizeof(int);
    return 0;
}`,
  },
  {
    label: 'Pointers',
    sample: 'int **pp = &p;',
    code: `int main(void) {
    int x = 1;
    int *p = &x;
    int **pp = &p;
    void *v = p;
    **pp = 2;
    return 0;
}`,
  },
  {
    label: 'Arrays',
    sample: 'int grid[2][3];',
    code: `int main(void) {
    int a[] = {1, 2, 3};
    int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
    grid[1][2] = a[0];
    return 0;
}`,
  },
  {
    label: 'Structs',
    sample: 'p->next = NULL;',
    code: `typedef struct Node {
    int value;
    struct Node *next;
} Node;

int main(void) {
    Node a = {1, NULL};
    Node *p = &a;
    p->next = NULL;
    a.value = 2;
    return 0;
}`,
  },
  {
    label: 'Heap memory',
    sample: 'malloc  calloc  free',
    code: `int main(void) {
    int *p = malloc(3 * sizeof(int));
    int *q = calloc(2, sizeof(int));
    p[0] = q[1];
    free(p);
    free(q);
    return 0;
}`,
  },
  {
    label: 'Functions',
    sample: 'including recursion',
    code: `int fact(int n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}

int main(void) {
    int r = fact(4);
    return 0;
}`,
  },
  {
    label: 'Control flow',
    sample: 'if  while  for  break',
    code: `int main(void) {
    int total = 0;
    for (int i = 0; i < 5; i++) {
        if (i == 1) continue;
        else if (i == 4) break;
        total += i;
    }
    while (total > 0) total--;
    return 0;
}`,
  },
  {
    label: 'Strings',
    sample: 'char s[] = "hi";',
    code: `int main(void) {
    char s[] = "hi";
    char *t = "hello";
    s[0] = t[1];
    return 0;
}`,
  },
  {
    label: 'Output',
    sample: 'printf("%d\\n", x);',
    code: `#include <stdio.h>

int main(void) {
    int x = 3;
    printf("x = %d at %p\\n", x, &x);
    return 0;
}`,
  },
]);

/** What does not work yet, listed one per row. */
export const UNSUPPORTED = Object.freeze([
  {
    label: 'switch',
    code: `int main(void) {
    int x = 1;
    switch (x) { case 1: x = 2; break; }
    return 0;
}`,
  },
  {
    label: 'do … while',
    code: `int main(void) {
    int x = 0;
    do { x++; } while (x < 3);
    return 0;
}`,
  },
  {
    label: 'a ? b : c',
    code: `int main(void) {
    int x = 1;
    int y = x > 0 ? 1 : 2;
    return 0;
}`,
  },
  {
    label: 'Casts, like (int *)malloc(…)',
    code: `int main(void) {
    int *p = (int *)malloc(sizeof(int));
    return 0;
}`,
  },
  {
    label: 'const',
    code: `int main(void) {
    const int x = 1;
    return 0;
}`,
  },
  {
    label: 'Global variables',
    code: `int count = 0;

int main(void) {
    count = 1;
    return 0;
}`,
  },
  {
    label: 'Function prototypes',
    code: `int twice(int n);

int main(void) {
    return 0;
}`,
  },
  {
    label: 'Library calls other than malloc, calloc, free and printf (scanf, strlen, …)',
    code: `int main(void) {
    int x;
    scanf("%d", &x);
    return 0;
}`,
  },
]);

/** Valid C the page names in one line under the list. */
export const ALSO_UNSUPPORTED = Object.freeze([
  {
    label: 'realloc',
    code: `int main(void) {
    int *p = malloc(sizeof(int));
    p = realloc(p, 2 * sizeof(int));
    return 0;
}`,
  },
  {
    label: 'enum',
    code: `enum Color { RED, GREEN };

int main(void) {
    return 0;
}`,
  },
  {
    label: 'union',
    code: `union U { int i; double d; };

int main(void) {
    return 0;
}`,
  },
  {
    label: 'bitwise & | ^ << >>',
    code: `int main(void) {
    int x = 6 & 3;
    return 0;
}`,
  },
  {
    label: 'function pointers',
    code: `int one(void) {
    return 1;
}

int main(void) {
    int (*f)(void) = one;
    return 0;
}`,
  },
]);
