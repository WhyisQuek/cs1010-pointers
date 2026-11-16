# PointerViz interim report: audit and recommendations

Reviewed on 3 November 2026 (Singapore). This review covers the pasted report, the local project at commit `3d0e444520d6123e9a55e361f586fd0f7f902189` (version 2.2.1), and the primary sources linked below. An existing modification to `src/styles.css` was left untouched. No application behaviour was changed.

## Overall evaluation

The report has a coherent educational purpose, sensible objectives, and an unusually careful discussion of the limitations of the early questionnaire studies. Its strongest feature is the connection between representations of memory and activities that require learners to produce an answer. The distinction between generating an example program and recovering original source is also sound.

It needs substantive revision before submission. Section 3.3 currently undermines its credibility through absolute claims about Python Tutor, undefined behaviour, security and correctness. Section 3 under-reports engineering work already present in the repository. Section 4 proposes plausible activities but does not yet define a sufficiently concrete evaluation or distinguish what each activity could establish.

The main refinement should be to make the contribution precise: a bounded C teaching interpreter, an editable representation of memory, partial synthesis of example C from that representation, and formative challenges sharing the same semantic state. The report should assess whether this combination helps learners connect code with memory, without claiming that its individual ideas are new or its educational effectiveness is already established.

## 1. Evidence and verification limits

### Project checks actually performed

| Check | Result | What it establishes |
|---|---|---|
| Current `npm test` | 649 reported tests: 648 passed, 0 failed, 1 skipped | Existing regression expectations pass in this workspace. |
| Native differential suite | Skipped: compatible compiler unavailable to the test command | No fresh native-compiler validation was completed in this review. WSL inventory also returned access denied. |
| Existing N3088 audit script | 70 probes: 56 matches, 14 discrepancies/limitations | Current differences from full-language expectations in this targeted set. All 14 are explicit rejections: 13 `unsupported`, 1 `limit`. They are not 14 newly found execution bugs. |
| Supplementary report examples | 13 checks, 0 failures | Reproduces the report's bounds example, relevant pointer rules, scalar-read and arithmetic diagnostics, one C23 feature, a subset rejection, and a generated-code round trip. |
| Source inspection | Interpreter, memory references, addresses, code generation, equivalence, challenges, telemetry, editions, documentation and CI | Supports implementation descriptions, subject to the boundaries below. |

Evidence files are alongside this review: `test-results.txt`, `standards-probe-results.jsonl`, `example-results.jsonl`, and `verify-examples.mjs`. Run the supplementary check from the repository root with `node docs/report-review/verify-examples.mjs`.

This was a report audit informed by implementation inspection and focused checks, not an exhaustive independent software verification. No learner study, performance benchmark, live telemetry database inspection, live Python Tutor comparison, or browser usability study was performed. The public PointerViz URL could not be fetched through the browsing tool, so its current deployment/version is not independently confirmed. Repository capability must not be confused with deployed configuration.

Some project documents are historical or partly stale. For example, the C11 audit predates exact 64-bit support; the language contract still contains an obsolete warning about braced null initializers despite a later fixed-status entry. Treat source and current reproduction results as stronger evidence of current behaviour than old prose or old test totals.

### Literature access

Full text was available for Lahtinen et al., Sorva (2013), Naps et al., the C-Sim author manuscript, Seward and Nethercote, and N3220. Milne and Rowe was checked against the publisher's abstract and metadata; its complete methods were not independently inspected. The 2009 Hundhausen paper was checked against its university record and abstract, with a related earlier author paper supporting the ALVIS mechanism. UUhistle's publication details were checked against its university record; detailed implementation claims should receive a final check against the original six-page paper. These access limits are reflected in the revised text.

## 2. Corrections in priority order

### F1 — Remove the guarantee of native correctness (critical; §3.3.3)

**Original:** Python Tutor supports the whole language and standard library, and native compilation makes its emulation “necessarily correct”.

**Finding:** Its own documentation lists C/C++ restrictions, including input, function pointers, unions, bitfields and visualisation limitations. A native compiler executes a particular implementation; undefined behaviour has no required portable outcome, implementation choices vary, and extraction/rendering can introduce errors. Compiler and tooling defects are possible too. The [Python Tutor limitations document](https://github.com/pythontutor-dev/pythontutor/blob/master/unsupported-features.md) directly contradicts the whole-language claim.

**Refinement:** Say that using a mature compiler reduces the amount of language semantics that the visualiser itself must implement. Then distinguish compiler coverage, visualisation coverage and diagnostic coverage. Both architectures require validation. Delete “genuinely” and “necessarily correct”.

### F2 — Qualify the Memcheck example and diagnosis point (critical; §3.3.1)

**Original:** `a[4]` is not reported because it accesses valid stack memory; PointerViz reports an error at the write.

**Finding:** The address is outside the C array. It may nevertheless be addressable according to Memcheck. Stack layout, generated instructions and optimisation affect whether any particular execution produces a report. The general limitation is reliable; the deterministic claim about this particular run is not. See the [Valgrind FAQ on missed array overruns](https://valgrind.org/docs/manual/faq.html#faq.overruns).

The local reproduction reports `pointer arithmetic moves outside allocation bounds (index 4)`. PointerViz rejects formation of the invalid subscript address before the store. This is pedagogically useful: forming a one-past pointer is permitted, dereferencing it is not, and forming a pointer farther beyond the array is already outside the rule.

**Refinement:** Use “Memcheck may miss a stack-array overrun when the computed address remains addressable”, and “PointerViz rejects the out-of-bounds subscript while evaluating the statement”. Do not describe memory outside the array as valid C memory for that access.

### F3 — Distinguish pointer equality, ordering and subtraction (critical; §3.3.1)

**Original:** “pointer arithmetic/comparison into different live objects”.

**Finding:** Equality comparison of compatible pointers to distinct live objects is permitted. Relational ordering has narrower rules, including permitted cases involving members of the same aggregate; subtraction requires the same array, with one-past cases allowed. The broad wording would teach a false rule. In N3220 these are §§6.5.7, 6.5.9 and 6.5.10; do not copy N3088 clause numbers without checking the newer draft. See [N3220](https://open-std.org/jtc1/sc22/wg14/www/docs/n3220.pdf).

**Refinement:** Name out-of-bounds pointer arithmetic, subtraction across unrelated arrays, and relational ordering outside the permitted cases. The supplementary checks confirm that PointerViz accepts separate-object equality and direct struct-member ordering, and rejects unrelated-object ordering/subtraction.

### F4 — Bound the undefined-behaviour claim (high; §3.3.1)

**Original:** “An error is reported as soon as a rule is broken”; “copying an uninitialised value”; Python Tutor does not catch the listed cases.

**Finding:** No complete undefined-behaviour detector is implemented. The repository explicitly excludes complete UB analysis. An uninitialised `int` scalar read is a good concrete example; arbitrary copying of object representations is a broader and more subtle topic. Memcheck can track undefined data through copies and report later consequential uses, rather than diagnosing every copy. Its behaviour alone does not establish the full behaviour of Python Tutor's additional plugin. See the [Memcheck manual, §4.2.2](https://valgrind.org/docs/manual/mc-manual.html#mc-manual.uninitvals) and [Seward and Nethercote (2005)](https://www.usenix.org/legacy/events/usenix05/tech/general/full_papers/seward/seward.pdf).

**Refinement:** Describe “selected runtime checks in the supported subset” and give `int x; int y = x;`. Call a diagnostic a teaching response to UB, rather than an outcome C itself requires. Any stronger tool-to-tool claim needs saved source, tool version/date and actual observed output. Do not execute UB programs natively to assign them a supposedly correct result.

### F5 — Correct cost and security absolutes (high; §3.3.2)

**Original:** No CPU/memory/security concerns apply; a runaway program affects only one learner; hosting costs do not grow with learners.

**Finding:** Local interpretation removes the need to execute learner-supplied native binaries on the host, and distributes interpretation work to client devices. Browser resource use remains relevant; the implementation already enforces it. Static delivery, telemetry and operational support can scale with usage. A browser tab can also affect device responsiveness. This is an architecture-based inference, not a measured cost comparison.

**Refinement:** Discuss reduced server execution requirements. Cite actual limits: 256 iterations per loop, 32 calls deep, 500 trace steps, and bounded snapshots/output. These are safeguards, not a formal security guarantee. Source: [limits.js](C:/Users/Timothy/Documents/NUS/pointer-viz/src/language/limits.js:1).

### F6 — State the language and teaching-machine contract (high; §§1.3, 3.1, 4.1)

The current contract targets a bounded **C23** subset with an LP64 model, signed 8-bit `char`, 32-bit `int`, 64-bit `long`/pointers, and simulated addresses. LP64 is not the Windows host's usual LLP64 model. State sizes and address reservations are teaching choices; source declaration order and screen position are not a native stack-layout guarantee. The tool uses allocation identity and subobject paths rather than raw addresses as pointer identity.

Also disclose at least the limits most relevant to learner programs: casts, `realloc`, input functions, general preprocessing, globals, prototypes and many library operations are unsupported. Do not list “etc.” as a language specification. `#include` handling does not provide a real preprocessor or arbitrary library access.

N3220 is a reasonable public reference: WG14 lists it as the similar draft for C23, while formally identifying it as an early C2y draft. It is not the published standard or the latest draft. Add its bibliographic entry and explain that existing probes were derived from **N3088**; migrating their clause references is planned work. See [WG14's status page](https://open-std.org/jtc1/sc22/wg14/www/projects.html).

### F7 — Explain partial generation and equivalence (high; §§1.3, 3.1)

O2's “bi-directional conversion” can imply lossless inversion. Retain the qualification already present in §3.1 and bring it into the objective: supported diagrams generate one example program. Multiple programs can have the same depicted state. A snapshot omits source history, and generator support is narrower than interpreter support.

Current generation rejects non-main frames, expired stack objects, some unreachable heaps and some pointer-to-whole-array heap configurations. These are implementation/representation restrictions; they do not establish that no C program could ever produce such a situation. A checkpoint before `main` completes is a more precise description of what the diagram depicts than memory remaining after process termination.

Source: [codegen.js](C:/Users/Timothy/Documents/NUS/pointer-viz/src/pipeline/codegen.js:176). Proposed invariant: interpreting generated code should produce a state equivalent under the tool's defined grading relation, on the generator's supported domain. This is a testable invariant, not an established universal theorem.

### F8 — Define what challenges actually assess (high; §§2.2.2, 3.1, 4.3)

The grader compares semantic memory graphs, not source strings, screenshot pixels or numeric address layouts. Types, values, pointer targets and relevant lifetimes matter; names and lifetimes have options. Heap allocations are paired structurally. All heap blocks, including freed ones, count; expired stack objects and literals count when reachable through compared pointers. Name-insensitive stack matching currently still depends on order; avoid claiming complete alpha-equivalence.

Source: [equivalence.js](C:/Users/Timothy/Documents/NUS/pointer-viz/src/pipeline/equivalence.js:95).

Final-state equivalence cannot show that learners used a requested loop, function, recursion or sequence of pointer assignments. A different supported program can reach the same state. Keep intermediate-state challenges as future work; current level normalisation has no step selector. Code-to-diagram targets must also be drawable: the editor cannot construct every state the interpreter can display, including some one-past, literal and lifetime states. Explain these boundaries and add at least one equivalence test example to the report.

### F9 — Report implemented O4 support and current validation (high; §3)

The summary omits the guided tutorial, examples, separate instructor build, course challenge packs, structured diagnostics and existing automated tests. There are **18 built-in challenges** in the inspected source. These provide concrete evidence of progress against O3/O4. They are not evidence of student adoption, instructor approval, usability or learning gain.

Add an objective/status/evidence table. Describe the parser → checker/interpreter → shared memory state → view/grader/generator architecture. Explain that stepping backwards selects recorded states rather than reversing C execution. Add the current test result with its date and the native skip, then state what remains to be validated. Avoid presenting every correctness activity as future work.

### F10 — Correct telemetry completeness and research-data wording (high; §§4.1–4.3)

“Telemetry already records every program a student runs and every error” is too strong. The collector is configured at build time. The client records specific Run/Generate/Check actions; blocked transport, truncation, rate limits and unsupported data can lose events. Nothing inspected establishes the live collector's configuration or completeness.

The client includes a persistent random browser identifier and a session identifier; source comments may contain identifying details. Describe this as browser-linked usage data, not confidently as anonymous data or “no personal information”. Browser IDs are not reliable counts of unique students. Hints, dwell time, every edit and every playback step are not currently instrumented.

Source: [telemetry client](C:/Users/Timothy/Documents/NUS/pointer-viz/src/data/telemetry.js:61), [notice](C:/Users/Timothy/Documents/NUS/pointer-viz/src/components/TelemetryNotice.jsx:1), and [telemetry documentation](C:/Users/Timothy/Documents/NUS/pointer-viz/docs/TELEMETRY.md:1).

The current notice is an acknowledgement, not an opt-in mechanism; dismissing it does not gate recording. Report this honestly and establish the applicable institutional review/consent route before using data for research. NUS guidance discusses prior approval and problems with retrospective research review. This review does not determine the project's approval status or whether a particular exemption/waiver applies. See the [NUS-IRB FAQ](https://www.nus.edu.sg/research/irb/resources).

### F11 — Strengthen evaluation and distinguish populations (high; §4.3)

The existing paragraph identifies reasonable measures but leaves the primary question, intervention, assessment, baseline and analysis unspecified. Add the protocol proposed in §5 of this review. CS2100/CS2106 participants may have substantial programming experience despite limited C experience; do not label the whole sample novice programmers. Record previous languages, C experience and baseline pointer knowledge, and analyse heterogeneous cohorts accordingly.

The [CS2100 description](https://www.comp.nus.edu.sg/~cs2100/1_course_info/desc.html) supports the relevance of C, not any claim about this future sample's ability or a confirmed recruitment arrangement. Keep both module involvement and semester scheduling conditional until staff agree.

### F12 — Make the course-coverage claim auditable (medium; §1.3)

Using CS1010 as a reference is appropriate, but a list of supported syntax is not a curriculum mapping. Current [CS1010 pointer material](https://cs1010.org/notes/a-primer-on-pointers-(part-2)) includes pointer-to-pointer operations, dynamically allocated arrays and `realloc`; the latter is unsupported here. Select relevant tasks and record supported, adaptable and excluded examples. Do not imply full course-program compatibility. Also explain why CS1010 guides the content while later modules are candidate recruitment settings.

### F13 — Remove unsupported causal and popularity claims (medium; §§1.1, 3.3)

Replace “primarily attributed” with a reasoned design motivation: source code does not directly depict storage or aliasing, so these relationships may be difficult to reason about. The cited questionnaires do not identify the primary causal mechanism. Cite the literature in the motivation rather than leaving it unsupported.

Replace “the most widely used comparable tool” with “a widely used comparator” or simply “a comparable tool”. No comparative adoption evidence was supplied. Do not equate convenience of access with demonstrated adoption.

## 3. Literature and citation audit

| Source | Verdict on the report's use | Recommended adjustment |
|---|---|---|
| Lahtinen et al. (2005) | Sample totals and the highest-rated concept claim verified. | Table 2 gives 3.59/5 for students and 4.44/5 for teachers on pointers/references; item responses are 518/32, distinct from total samples 559/34. Keep the perception and language caveats. [Paper](https://www.cs.uni.edu/~schafer/cohort23/TLP/lessons/w11/papers/A_study_of_the_difficulties_of_novice_programmers.pdf). |
| Milne & Rowe (2002) | Publisher abstract supports the memory-related difficulty and mental-model explanation. | Retain the distinction between findings and authors' interpretation. Full methods/sample detail remains a final library check. [Publisher](https://link.springer.com/article/10.1023/A:1015362608943). |
| Sorva (2013) | Notional machine and explicit learning-objective argument verified. | Distinguish the model of execution from a diagram representing it. [Author-uploaded text](https://www.researchgate.net/publication/259998496_Notional_Machines_and_Introductory_Programming_Education). |
| du Boulay (1986) | The attribution is supported by Sorva's discussion. | Direct 1986 full-text wording was not independently checked. Cite Sorva for the synthesis unless reading the original; do not silently imply a direct quotation from 1986. |
| Perez-Schofield et al. (2019) | Prior-year grade comparison and its limitation accurately represented. | Preserve the caution. The pre/post questionnaires are substantially perceptions/confidence, so do not relabel them as objective learning tests. Fix the compound surname García Rivera rather than Rivera alone. [Author manuscript](https://reflection.uniovi.es/ortin/publications/caee2019.pdf). |
| Naps et al. | Categories, overlap and the absence of a strict hierarchy verified. | The bibliography mixes 2002 proceedings metadata with 2003 in-text citations. Use the 2003 SIGCSE Bulletin version consistently, or consistently identify the 2002 proceedings version. This is a version mismatch, not proof that 2002 is inherently wrong. [University record](https://rex.libraries.wsu.edu/esploro/outputs/journalArticle/Exploring-the-role-of-visualization-and/99900547176001842), [author-uploaded full text](https://www.researchgate.net/publication/234814597_Exploring_the_role_of_visualization_and_engagement_in_computer_science_education). |
| Hundhausen et al. (2009) | The direct-manipulation/transfer precedent is supported by the university abstract. | Full title ends “An experimental study”. Add that their study concerns transfer in its own environment, not evidence of transfer to C pointers. Fine-grained SALSA interface claims need the original journal paper. [University record](https://rex.libraries.wsu.edu/esploro/outputs/journalArticle/Can-direct-manipulation-lower-the-barriers/99900547563901842). |
| Sorva & Sirkiä (2010) | Relevant automatic-assessment precedent; original title is incomplete in the report. | Use “UUhistle: A software tool for visual program simulation”, pages 49–54, DOI 10.1145/1930464.1930471. Distinguish stepwise simulation from final-state construction. [University record](https://research.aalto.fi/en/publications/uuhistle-a-software-tool-for-visual-program-simulation/). |
| Seward & Nethercote (2005) | Bit-precision validity tracking is supported. | Add pages 17–30 and use it for Memcheck's mechanism, not unobserved claims about every Python Tutor diagnostic. [Proceedings paper](https://www.usenix.org/legacy/events/usenix05/tech/general/full_papers/seward/seward.pdf). |
| Python Tutor / Valgrind web sources | Useful primary sources for implementation and documented limitations. | Prefer stable official project/manual pages over an inaccessible Google Doc, include access date, and avoid unsupported negative claims about current deployed behaviour. |
| N3220 | Cited in the body but absent from references. | Add WG14 corporate-author entry, date 22 February 2024, draft status and link. Existing N3088-derived validation should be identified separately. |

Two worthwhile additions are [Hundhausen, Douglas and Stasko's 2002 meta-study](https://faculty.cc.gatech.edu/~stasko/papers/jvlc02.pdf), which strengthens the empirical basis for discussing how learners use visualisation, and [Sorva, Karavirta and Malmi's 2013 review](https://research.aalto.fi/en/publications/a-review-of-generic-program-visualization-systems-for-introductor/), which provides broader related-tool positioning. Add them where they advance an argument, not simply to lengthen the bibliography. A technical discussion of pointer provenance could optionally cite [Memarian et al. (2019)](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n2311.pdf); it would not make PointerViz a complete implementation of a formal C semantics.

## 4. Details worth adding to the report

1. **A precise contribution paragraph.** Explain the integrated system and the remaining empirical question. Avoid a global novelty claim without a wider tool search.
2. **A short notional-machine definition.** State what an object, stored scalar value, pointer, array boundary, lifetime and frame mean in this teaching model. Label addresses as simulated. Explain why keeping freed objects visible is historical feedback, not permission to use them.
3. **One worked example and two figures.** Use `int x=5; int *p=&x; int *q=p; *q=9;`. Show that `p` and `q` store the same target, while `&p` and `&q` identify different pointer objects. Include an actual UI screenshot with a readable legend and an architecture figure. A second small null/freed comparison would clarify lifetime handling. Do not invent native addresses.
4. **Objective-to-evidence table.** Mark O1–O4 as implemented, partial or awaiting evaluation, with named examples/tests and remaining limitations.
5. **Challenge semantics.** Define equivalence, give two different correct source answers, and explain why a matching final state does not prove a requested algorithm was used.
6. **A small coverage/validation matrix.** Map concepts to supported examples, positive/negative tests and exclusions; include pointer equality, one-past formation, lifetime, arithmetic, conversions and layout.
7. **An explicit research protocol and analysis boundary.** Separate usability, immediate transfer and retention. Include an unassisted assessment.
8. **A feasible timetable and dependencies.** Name staff coordination and the applicable ethics route as dependencies; specify what deliverable remains possible if recruitment fails.

An architecture diagram is justified by the project's design. A large feature table, exhaustive standard-clause catalogue or a screenshot of every control is unnecessary in the main report; put detailed language coverage and test cases in an appendix or linked technical document.

## 5. Proposed evaluation protocol

The following is a proposal, not a description of an approved or completed study.

| Research question | Evidence | Practical design and interpretation |
|---|---|---|
| RQ1: Does PointerViz behave as specified on the declared subset and model? | Standard-derived positive/negative examples, compatible native comparisons for defined programs, round trips, grading tests | Classify valid/unsupported/constraint-violating/undefined cases separately. Record compiler, flags, ABI, app version and seed/fixture. Test expected values independently of the interpreter. |
| RQ2: Can intended learners use the representations and controls correctly? | Observed completion, incorrect actions, explanations, assistance needed and brief interviews | Begin with a small formative pilot, for example 5–8 participants. This is a planning range, not a guarantee of saturation or a statistical sample-size justification. Cover code stepping, aliasing, diagram editing, generation and both challenge types. |
| RQ3: After structured use, can learners solve new pointer tasks independently? | Parallel pre/post tasks, explanations and optional delayed tasks | Assess outside PointerViz, with generation/hints unavailable. Balance aliasing, pointer vs pointee, arrays and lifetime. Pilot the rubric and check a subset with a second marker where feasible. |
| Optional RQ4: Does diagram construction/generation add value beyond playback? | Comparison between defined activity conditions | Requires comparable instructional content, duration and feedback. A whole-tool comparison cannot isolate O2. Omit this causal question if recruitment cannot support it. |

Recommended sequence: baseline experience questionnaire and pre-test; standardised tutorial; timed/observed practice; unassisted post-test; brief explanation/interview; optional delayed assessment. Use different but comparable code in pre/post forms, counterbalance form order where feasible, and distinguish practice success from transfer.

If a comparison group is feasible, allocate participants randomly or justify allocation, keep topic exposure and time comparable, and record prior C experience. A baseline-adjusted comparison can be planned, with effect estimates and uncertainty. Do not promise a particular significance test or a powered causal result before knowing the sample and design. With a single group, report paired changes descriptively and explicitly retain practice, maturation, teaching and self-selection as alternative explanations.

Challenge attempts are repeated observations within learners; do not analyse each attempt as an independent participant. Browser IDs alone cannot link usage reliably to consented students or tests. If research linkage is needed, design a separate approved identifier procedure. Also record tool bugs encountered during sessions so low scores caused by a defect are not interpreted as misconceptions.

Specify the analysis before collecting outcomes: total and concept-level assessment scores, rubric examples, inclusion/exclusion rules, missing data, qualitative coding procedure, and what outcomes count as success. Set numerical usability thresholds after a pilot or justify them explicitly; no threshold or sample size is established by this review.

## 6. Proposed work sequence

| Phase | Deliverable | Dependency / fallback |
|---|---|---|
| First 1–2 weeks | Fix report claims; freeze supported subset; reconcile stale documentation; establish study/telemetry review status | Coordinate with supervisor and relevant staff. |
| Following 2–3 weeks | Clause-to-test matrix, native CI evidence, generation/grading boundary checks; small usability pilot | Recruit only through the applicable authorised process. |
| Next agreed teaching window | Structured learning evaluation | Freeze tested version and materials; timing depends on staff and participants. |
| Final analysis period | Defect fixes, results and limitations; final dissertation | If recruitment fails, deliver correctness evidence and formative findings, without claiming demonstrated learning effectiveness. |

Prioritise correctness, clear diagnostics and evaluation over expanding the C subset. New features should have a concrete teaching or usage justification, positive and negative tests, and a documented effect on generation and grading. Multiple-frame generation is potentially substantial work; treat it as stretch scope rather than an assumed extension.

## 7. Editorial refinements

- Restore the missing §3.2. A useful structure is §3.1 implemented capabilities, §3.2 architecture and validation, §3.3 design alternatives.
- Fix “Eacg” → “Each”; “without requiring students install” → “without requiring students to install”.
- Use “behaviour”, “initialised” and “visualisation” consistently, while preserving official paper titles and exact diagnostic text.
- Use consistent heading numbering, “Table of Contents”, and automatic page numbering after final layout.
- Replace broad “memory addresses are invisible” wording with the distinction between explicit source expressions and the runtime relationships they denote.
- Avoid “etc.” in supported types; use a compact bounded list or refer to the language contract.
- Place the citation before the sentence-ending full stop consistently; repair the isolated parenthetical Hundhausen sentence.
- Replace “both directions” where necessary with “the two supported task directions”; the domains of forward execution, editable diagrams and reverse generation differ.
- Distinguish implementation objectives from learning outcomes, and observed results from planned work throughout.
- Alphabetise the final reference list and use one citation style. Include article numbers for ACM journals, full titles, DOIs, and access dates for changing web documentation.

## 8. Items requiring author confirmation before submission

The revised report avoids inventing these details: the deployed version and telemetry setting; actual usage counts; research review/consent status and treatment of existing data; confirmed teaching partners; recruitment window and numbers; dissertation deadline and page limit; supervisor-required citation style; and the original full-text details for the partially accessed papers. Resolve these through project records, library access and supervisor/staff coordination. They do not prevent the textual and technical corrections supplied here.

The companion `REFINED_REPORT.md` applies the principal corrections and additions in a complete replacement draft. It labels future work as proposed and preserves uncertainty where the available evidence cannot resolve it.
