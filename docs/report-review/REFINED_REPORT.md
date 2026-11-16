# B.Comp. Dissertation

# C Memory Model and Pointer Visualiser

## Interim Report

Timothy Quek Jing Yuan  
Department of Computer Science  
School of Computing  
National University of Singapore  
Academic Year 2026/2027

*Editorial note, to remove before submission: This replacement draft was checked against the local PointerViz 2.2.1 project on 3 November 2026. Study arrangements remain proposals. Confirm the deployed version, telemetry configuration, research review status, submission requirements and original-paper details identified in the accompanying audit before submitting. Add actual interface figures and generate the table of contents after pagination.*

## 1 Project Overview

### 1.1 Motivation

Pointers and memory-related concepts are recurring difficulties in introductory programming. Surveys identify pointers and references as particularly difficult, although these findings primarily measure perceptions and concern languages including C++ and Java rather than C alone (Lahtinen et al., 2005; Milne & Rowe, 2002). They motivate attention to the topic without establishing either the prevalence of particular misconceptions among novice C programmers or their causes.

Reasoning about C pointers requires distinguishing objects, their stored values and the objects they reference. For a pointer variable `p`, its own address `&p`, its stored pointer value `p`, and the value obtained through `*p` play different roles. These relationships must be inferred from the execution of source code. An explicit representation of execution may help learners inspect and reason about them, but its educational value must be evaluated rather than assumed.

### 1.2 Aim and intended contribution

This project aims to design, implement and evaluate PointerViz, an interactive browser-based tool for learning about pointers and memory in a supported subset of C.

The intended contribution is an integrated environment in which learners can execute C and inspect memory, construct memory diagrams and obtain example C, and practise connecting the two representations through automatically checked challenges. A shared semantic representation supports execution, visualisation, generation and assessment. The project will evaluate both the tool's behaviour within its declared scope and its usability and potential educational value.

Here, a memory model means the teaching model used to represent objects, pointer relationships and lifetimes. The project does not propose a replacement for the ISO C memory model or a complete implementation of the language.

### 1.3 Specific objectives

**O1: Execute learner-written C and visualise its effects on memory.** Allow learners to enter and modify supported C programs, step through recorded execution states, and inspect objects, values, pointer relationships and relevant changes. Make distinctions such as `&p`, `p` and `*p` explicit. Use relevant CS1010 Programming Methodology topics as a curriculum reference while documenting unsupported constructs and implementation choices.

**O2: Generate example C from supported memory diagrams.** Allow learners to create objects, edit values and choose compatible pointer targets, then generate an example program that constructs an equivalent represented state. This is a partial conversion over supported diagrams; it does not recover original source or execution history.

**O3: Provide practice and formative feedback.** Offer challenges in which learners construct a memory diagram for supplied C, or write C that produces a target diagram. Check answers against a defined memory-state equivalence relation and provide feedback, hints and opportunities to revise.

**O4: Support classroom use.** Provide browser access without requiring learners to install a compiler, together with a guided introduction, examples and instructor-authored challenge packs. Investigate practical barriers to use in the intended teaching setting.

## 2 Literature Review

### 2.1 Difficulties in learning pointers and memory

Lahtinen et al. (2005) surveyed 559 students and 34 teachers across six universities. Pointers and references received the highest mean difficulty ratings among the programming concepts surveyed: 3.59 out of 5 from responding students and 4.44 from responding teachers. The item-specific response counts were 518 and 32 respectively. Milne and Rowe (2002) likewise identified difficulties with object-oriented topics that depend on understanding pointers and memory.

These studies concern perceived difficulty rather than direct demonstrations of understanding. Their language and institutional contexts also limit generalisation to C learners at NUS. Teachers' higher ratings do not independently show that students overestimate their understanding. The findings establish a recurring concern rather than a precise account of local learning needs.

Milne and Rowe interpret memory-related difficulties in terms of learners' mental models of execution. Their questionnaire does not establish that explanation causally. Sorva's (2013) review develops the broader argument that understanding how programs execute should be an explicit learning objective. A notional machine is an abstract execution model that learners can use to reason about program behaviour; a visualisation is one possible representation of that model.

C-Sim provides a directly relevant C-based precedent. It lets learners inspect the memory effects of entered instructions. Perez-Schofield et al. (2019) reported improved assessment results relative to students from the preceding academic year, alongside favourable student perceptions. The historical comparison cannot isolate the tool from cohort or teaching differences. Its questionnaire evidence also should not be treated as an independent objective measure of learning. The study provides qualified motivation for inspecting memory behaviour, rather than proof that any such visualisation improves understanding.

For PointerViz, these findings motivate O1 and a model that makes objects, stored values, aliasing and lifetimes inspectable. Whether learners can use that representation to reason more accurately remains an empirical question.

### 2.2 Engagement with visualisations

The way learners use a visualisation matters alongside its visual content. Hundhausen et al.'s (2002) meta-study of algorithm visualisation evaluations supports investigating learning activities rather than assuming that displaying execution is sufficient.

Naps et al. (2003) describe viewing, responding, changing, constructing and presenting, alongside no viewing. These categories can overlap and do not form a strict hierarchy. PointerViz supports viewing through playback, changing through program modification, constructing through diagram editing, and responding through challenges. These classifications describe available activities; they do not establish learning gains. Dedicated support for presenting to an audience is outside the present scope.

#### 2.2.1 Constructing and connecting representations

Direct manipulation can let learners express an intended arrangement before they know its textual syntax. Hundhausen et al. (2009) investigated a direct-manipulation programming interface and found benefits for initial programming and transfer to a textual interface in their experimental setting. This provides a relevant precedent, but it does not establish transfer to C pointer programming.

Applied to PointerViz, a learner might first draw `p` pointing to `x`, then inspect generated declarations and an assignment such as `p = &x;`. This motivates O2. Generation is intended to provide an example connecting the representations. It also creates an evaluation risk: learners may reproduce generated syntax without understanding it. Assessment should therefore include new tasks completed independently of the generator.

#### 2.2.2 Responding and formative assessment

UUhistle illustrates visual program simulation and automatic assessment in an introductory programming environment (Sorva & Sirkiä, 2010). PointerViz adopts a related principle of requiring learners to supply an answer that can be checked, while focusing its current challenges on represented memory states.

The two proposed task directions are complementary. Given code, learners construct the resulting diagram; given a diagram, they write a program producing an equivalent state. Both require an explicit connection between instructions and memory. The former also involves construction, illustrating that engagement categories overlap. These activities motivate O3, but successful final-state matching alone does not demonstrate understanding of every intermediate operation.

### 2.3 Design implications

The literature motivates three design requirements: represent the effects of pointer operations explicitly; allow learners to construct and connect representations; and provide tasks that require a response with feedback. Browser access and instructional support address practical classroom use under O4. The resulting system combines established ideas for a particular C teaching context; its contribution and effectiveness must be assessed within that scope.

## 3 Progress

### 3.1 Implemented capabilities and objective status

PointerViz 2.2.1 is a working browser-based application. The project identifies `viz.cs1010.org` as its public deployment. This progress account concerns the inspected local version; the deployed version should be recorded separately when reporting classroom use.

The interpreter supports primitive numeric and Boolean types, `size_t`, pointers including multiple indirection and selected pointer arithmetic, fixed-size and multidimensional arrays, named structures and struct typedefs, self-referential structures, functions and recursion, lexical scopes, `if`/`else`, `while`, `for`, `break`, `continue`, and `return`. Supported library operations include `malloc`, `calloc`, `free` and a bounded implementation of `printf`. String literals and character arrays are also supported.

Learners can move forwards and backwards through recorded states, inspect call frames and heap objects, and view pointer targets and simulated addresses. Runtime failures retain playback of preceding states. Freed heap blocks and expired stack objects can remain in the teaching state so dangling relationships can be explained; retaining that history does not make the objects valid to access.

| Objective | Implemented support | Remaining work |
|---|---|---|
| O1 | Custom interpreter, execution trace, step navigation, simulated addresses, pointer relationships and change highlighting | Validate the declared subset and explanations; investigate learner interpretation of the diagrams. |
| O2 | Diagram editing and example C generation for supported states | Document and test generation boundaries; assess independent transfer from diagrams to C. |
| O3 | Both challenge directions, hints, feedback and 18 built-in challenges | Validate task coverage and grading; evaluate learner responses. |
| O4 | Browser student edition, guided tutorial, examples, separate instructor edition and published course challenge packs | Confirm teaching arrangements, deployment configuration and practical usability. |

These statuses describe implemented functionality. They do not establish adoption or educational effectiveness.

### 3.2 Architecture, teaching model and validation

#### 3.2.1 Shared semantic state

The system separates parsing, checking, execution, memory and presentation. Tree-sitter parses source into a project-owned representation. A checker validates supported constructs, and the interpreter updates a shared `MemoryState`. The visualisation, challenge grader and C generator operate on that state. Diagram positions are presentation data rather than part of C semantics.

The principal flow is:

```text
C source → parser → checker/interpreter → MemoryState
                                           ├→ memory visualisation
                                           ├→ challenge comparison
                                           └→ example C generation
```

Pointers retain allocation identity and a path to a subobject, supporting array boundaries, structure members and lifetime checks. Deterministic simulated addresses are derived from the model; they are not addresses in the learner's browser or native process. Moving an object on the canvas changes its layout, not its address or semantic identity. Backward stepping selects earlier recorded states rather than undoing a native C process.

The selected data model is LP64: `int` occupies four bytes, while `long` and pointers occupy eight. Plain `char` is signed and occupies one byte. Structure layout includes alignment and padding. These choices are documented teaching-machine properties rather than universal properties of C implementations. Operand evaluation follows a selected order where allowed, while checks attempt to reject supported cases of conflicting unsequenced accesses.

Important exclusions include casts, `realloc`, general preprocessing, global variables, function prototypes and many standard-library functions. Array sizes, call depth and execution history are bounded. The interface distinguishes invalid C, selected undefined behaviour, unsupported constructs, resource limits and internal tool errors. The current diagnostic coverage is itself a subject of testing.

#### 3.2.2 Generation and assessment boundaries

Generating C means constructing one program whose represented state matches a supported diagram. It does not reconstruct loops, function bodies or the sequence that originally produced a snapshot. Some interpreted states cannot currently be regenerated, including states with non-main frames, expired stack objects and selected heap configurations.

For example:

```c
int main(void) {
    int x = 5;
    int *p = &x;
    int *q = p;
    *q = 9;
    return 0;
}
```

The represented state after `*q = 9` has `x` equal to 9 and both pointers referring to `x`. A generated program could initialise `x` to 9 and assign both pointers directly. It would represent the same arrangement at the relevant checkpoint while having a different history. The visualisation retains a teaching snapshot rather than claiming that local variables remain alive after the program terminates.

Challenge comparison uses types, values, pointer relationships and relevant object lifetimes. Variable names and lifetime comparison are configurable. Heap objects are matched structurally rather than by generated allocation identifiers; screen coordinates and simulated numeric addresses are not marking criteria. Consequently, different supported C programs can be valid answers. Final-state grading does not establish that a particular algorithm or sequence was used.

Code-to-diagram challenges are additionally restricted to targets that the editor can construct. Displayable, editable, generatable and gradable states have overlapping but different boundaries. These restrictions must be considered when authoring exercises.

#### 3.2.3 Validation completed so far

The repository already contains semantic regression tests, generation round trips, grading checks, playback/layout checks and browser smoke tests. It also defines differential tests against a compatible LP64 C23 compiler, with undefined-behaviour sanitisation for selected defined programs. Native comparison is required by the Linux CI configuration, although this report does not claim a newly verified remote CI run.

In the local audit on 3 November 2026, the standard test command reported 649 tests: 648 passed, none failed and one native differential test was skipped because a compatible compiler was unavailable to that command. A separate 70-probe N3088 audit reported 56 matches and 14 explicit subset/resource rejections. These probes are targeted examples, not a statistical conformance score or a count of independent defects. Thirteen supplementary report-example checks also passed, including a generated aliasing-state round trip.

The tests provide evidence for particular cases. They do not prove complete conformance, exhaustive undefined-behaviour detection, or correctness of every generated program. The remaining work will extend and organise this evidence against the declared contract.

### 3.3 Design alternatives

#### 3.3.1 Custom interpretation and native execution

A central decision is to interpret a bounded C subset inside the browser. Python Tutor provides a comparator whose published documentation describes GCC compilation and Valgrind Memcheck-based execution, together with language and visualisation restrictions (Python Tutor, n.d.). A compiler-based design delegates substantially more language behaviour to existing tooling; a custom interpreter makes the represented state and teaching diagnostics directly controllable.

Memcheck tracks addressability and definedness, with bit-level tracking of value validity (Seward & Nethercote, 2005). Its documentation explains that stack/global array bounds are not generally checked and that undefined data can propagate before a report is issued for a consequential use (Valgrind, n.d.-a, n.d.-b).

Consider:

```c
int a[3];
a[4] = 5;
```

Memcheck may miss an overrun when the resulting address remains addressable in its model. The exact result of a particular compiled program depends on compilation and runtime conditions. PointerViz's reproduction rejects the subscript when its pointer arithmetic moves outside the allocation bounds, before storing the value. This illustrates a difference between object-aware checking in the teaching model and detection based on the addressability of a compiled access.

PointerViz also diagnoses selected uninitialised scalar reads and signed arithmetic overflow. Its pointer checks distinguish equality from relational ordering and subtraction, and permit one-past pointer formation while rejecting dereference. These are bounded diagnostics within the supported model, not a claim to detect every form of undefined behaviour. Nor do Memcheck's documented limits alone establish all behaviour of Python Tutor's additional visualisation tooling.

#### 3.3.2 Operational considerations

Executing learner programs in the browser removes the need for PointerViz's host to compile and run learner-supplied native binaries. Interpretation work is distributed to learners' devices, supporting browser-based classroom access. This is an architectural benefit rather than a measured guarantee of cost or security.

Client resource limits remain necessary. The implementation bounds loops to 256 iterations each, call depth to 32 and execution traces to 500 steps, alongside memory-history and output limits. Hosting still serves application assets, and optional telemetry introduces server-side storage and request handling. Operational cost and responsiveness should therefore be assessed under the intended workload rather than assumed to be independent of usage.

#### 3.3.3 Coverage and fidelity

The principal cost of custom interpretation is implementing and validating every supported feature. PointerViz targets a bounded C23 subset under documented choices and simplifications. For example, allocation failure is not simulated for permitted nonzero requests, and allocated storage is assigned its represented type on pointer conversion rather than modelling all effective-type behaviour. Such boundaries must be visible to learners and instructors.

Using a mature compiler reduces this semantic implementation burden, but does not guarantee portable outcomes for undefined programs, uniform implementation choices or error-free visualisation. Python Tutor also documents unsupported features. Both approaches require validation; they distribute responsibility between language execution, instrumentation, representation and presentation differently.

## 4 Research Plan

The remaining work will prioritise correctness, explanations and evaluation. Additional features will be selected only when they address a demonstrated teaching need within the available time.

### 4.1 Correctness and scope validation

The reference behaviour will be documented against C23 using publicly accessible draft N3220. WG14 lists it as the similar draft for ISO/IEC 9899:2024 while identifying it as an early C2y draft (ISO/IEC JTC1/SC22/WG14, 2024). Existing N3088-derived probes will be retained, with differences and clause references checked during migration. PointerViz's LP64 choices and teaching simplifications will be recorded separately from language requirements.

Validation will use four complementary approaches:

1. **Standard-derived cases.** Map supported concepts to positive examples, constraints, selected undefined operations and exclusions. Include array boundaries, conversions, layout, pointer relationships, allocation and lifetimes.
2. **Differential testing of defined programs.** Compare results with compatible compilers under recorded versions, flags and implementation assumptions. Undefined programs will be checked for appropriate PointerViz diagnostics rather than assigned native reference outputs. Sanitiser silence will not be treated as proof of correctness.
3. **Representation invariants.** For supported generated states, interpret generated C and compare the result with the starting diagram. Test grading independently with both equivalent and deliberately different answers, including allocation order, aliases, values and lifetimes. Shared implementation paths make round trips useful consistency checks but insufficient independent semantic evidence.
4. **Reviewed usage examples.** Where collected data are available and authorised for this purpose, investigate suspected execution or diagnostic errors. Reduce confirmed defects to small examples and add regression tests. Unsupported features and limits will be distinguished from defects.

A curriculum matrix will identify which selected CS1010 examples run directly, require adaptation or fall outside scope. This is particularly necessary for operations such as `realloc` and course-library calls. It will clarify the use of CS1010 to guide content while other modules remain possible evaluation settings.

### 4.2 Possible extensions

Candidate extensions are intermediate-state challenges, clearer or broader code generation, and selected language/library additions. Intermediate-state tasks could assess reasoning at a specified checkpoint rather than only the final represented state. Generation work could improve readability and selected heap cases; support for multiple live frames remains a potentially substantial extension.

Feature priorities will consider observed difficulties, relevant teaching examples and implementation effort. If telemetry is configured, error records may help identify commonly attempted unsupported constructs. Such data are indicative rather than exhaustive: recording depends on deployment settings and transport, and events can be blocked or truncated. Current instrumentation records selected Run, Generate and Check actions rather than every edit or interaction.

Extensions will be accompanied by updates to the language contract, diagnostics, generation/grading boundaries and relevant tests. Correctness and evaluation take priority over adding features solely to increase coverage.

### 4.3 Evaluation with learners

The evaluation will distinguish three questions: whether the tool behaves according to its contract; whether intended learners can use its representations and controls; and whether structured use is associated with improved independent reasoning about pointers.

Subject to staff agreement and the applicable research review arrangements, students in CS2100 Computer Organisation or CS2106 Introduction to Operating Systems are possible participants. Prior programming experience and prior C experience will be recorded separately. Students taking these modules should not automatically be treated as novice programmers, and differences between recruitment settings will be considered in analysis.

#### 4.3.1 Formative usability study

A small initial pilot is proposed, provisionally with five to eight participants, to identify problems in the interface and study materials. This is a planning range rather than a guarantee that all usability problems will be found. Tasks will cover tracing an aliasing example, identifying a pointer's own address and stored target, editing a diagram, generating and explaining code, and attempting both challenge formats.

Observations will record completion, incorrect actions, assistance required and participants' explanations. Brief interviews will distinguish control difficulties from conceptual difficulties. The pilot will inform revisions before a larger evaluation; no population-level learning claim will be based on this small sample alone.

#### 4.3.2 Learning and independent transfer

A proposed learning study will use a baseline assessment, a standardised introduction and practice session, and an unassisted post-assessment. Questions will require tracing, explanation and short code construction, covering aliasing, pointer versus pointee values, arrays and lifetimes. Different but comparable pre/post questions will reduce direct recall, with form order balanced where feasible. A delayed assessment may examine retention if scheduling permits.

Assessment will be completed without PointerViz's generator or hints. This is necessary to distinguish success while supported by the tool from independent understanding. A scoring rubric will be piloted, and a subset of responses will receive a second marking where feasible. Confidence ratings will complement performance evidence rather than substitute for it.

A comparison condition with equivalent topic coverage and practice time will be sought if recruitment permits. Allocation, baseline differences and concurrent teaching will be reported. Comparing the complete tool with another condition would evaluate the instructional package; it would not isolate the effect of diagram-to-code generation. A feature-specific comparison would require an additional design and adequate recruitment.

The sample and analysis will be agreed before collecting outcomes. Reporting will emphasise score changes, concept-level difficulties, effect estimates and uncertainty as appropriate to the eventual design. Repeated challenge attempts will not be counted as independent participants. With only a single pre/post group, any improvement will be interpreted cautiously because practice, teaching and self-selection remain alternative explanations.

### 4.4 Research data and feasibility

The current telemetry implementation uses random browser and session identifiers and can record submitted source or diagram states when enabled. It does not establish anonymous participation, unique-student counts or complete usage histories. Its notice currently acknowledges recording rather than providing opt-in consent. Deployment configuration and the status of existing data will therefore be clarified before research use.

The applicable institutional review route, participant information, voluntary participation, consent or any authorised waiver, retention, access controls and possible linkage to assessments will be agreed with the supervisor and relevant staff. NUS guidance addresses approval before research and the difficulties of retrospective review (National University of Singapore, n.d.). No approved study or consent arrangement is claimed here.

Work will proceed through scope/documentation reconciliation, expanded validation, a formative pilot, and then a learning study if feasible. Staff coordination, review requirements and recruitment are dependencies. If a comparative study cannot be completed, the final dissertation will report the correctness evidence and any completed formative evaluation, while explicitly limiting claims about educational effectiveness.

## 5 References

Hundhausen, C. D., Douglas, S. A., & Stasko, J. T. (2002). A meta-study of algorithm visualization effectiveness. *Journal of Visual Languages & Computing, 13*(3), 259–290. [Author copy](https://faculty.cc.gatech.edu/~stasko/papers/jvlc02.pdf).

Hundhausen, C. D., Farley, S. F., & Brown, J. L. (2009). Can direct manipulation lower the barriers to computer programming and promote transfer of training? An experimental study. *ACM Transactions on Computer-Human Interaction, 16*(3), 1–40. [DOI](https://doi.org/10.1145/1592440.1592442).

ISO/IEC JTC1/SC22/WG14. (2024, February 22). *Working draft N3220: Programming languages—C*. [Public draft](https://open-std.org/jtc1/sc22/wg14/www/docs/n3220.pdf).

Lahtinen, E., Ala-Mutka, K., & Järvinen, H.-M. (2005). A study of the difficulties of novice programmers. *ACM SIGCSE Bulletin, 37*(3), 14–18. [Paper](https://www.cs.uni.edu/~schafer/cohort23/TLP/lessons/w11/papers/A_study_of_the_difficulties_of_novice_programmers.pdf).

Milne, I., & Rowe, G. (2002). Difficulties in learning and teaching programming—Views of students and tutors. *Education and Information Technologies, 7*(1), 55–66. [DOI](https://doi.org/10.1023/A:1015362608943).

Naps, T. L., Rößling, G., Almstrum, V., Dann, W., Fleischer, R., Hundhausen, C., Korhonen, A., Malmi, L., McNally, M., Rodger, S., & Velázquez-Iturbide, J. Á. (2003). Exploring the role of visualization and engagement in computer science education. *ACM SIGCSE Bulletin, 35*(2), 131–152. [DOI](https://doi.org/10.1145/782941.782998).

National University of Singapore. (n.d.). *NUS-IRB frequently asked questions*. Retrieved November 3, 2026, from the [NUS-IRB website](https://www.nus.edu.sg/research/irb/resources).

Perez-Schofield, B. G., García Rivera, M., Ortin, F., & Lado, M. J. (2019). Learning memory management with C-Sim: A C-based visual tool. *Computer Applications in Engineering Education, 27*(5), 1217–1235. [DOI](https://doi.org/10.1002/cae.22147). [Author manuscript](https://reflection.uniovi.es/ortin/publications/caee2019.pdf).

Python Tutor. (n.d.). *Unsupported features*. Retrieved November 3, 2026, from the [official project repository](https://github.com/pythontutor-dev/pythontutor/blob/master/unsupported-features.md).

Seward, J., & Nethercote, N. (2005). Using Valgrind to detect undefined value errors with bit-precision. In *Proceedings of the 2005 USENIX Annual Technical Conference* (pp. 17–30). [Paper](https://www.usenix.org/legacy/events/usenix05/tech/general/full_papers/seward/seward.pdf).

Sorva, J. (2013). Notional machines and introductory programming education. *ACM Transactions on Computing Education, 13*(2), Article 8, 31 pages. [DOI](https://doi.org/10.1145/2483710.2483713).

Sorva, J., & Sirkiä, T. (2010). UUhistle: A software tool for visual program simulation. In *Proceedings of the 10th Koli Calling International Conference on Computing Education Research* (pp. 49–54). [DOI](https://doi.org/10.1145/1930464.1930471).

Valgrind. (n.d.-a). *Frequently asked questions*. Retrieved November 3, 2026, from the [Valgrind website](https://valgrind.org/docs/manual/faq.html).

Valgrind. (n.d.-b). *Memcheck: A memory error detector*. Retrieved November 3, 2026, from the [Valgrind manual](https://valgrind.org/docs/manual/mc-manual.html).
