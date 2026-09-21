# Save-triggered POM regeneration

A Vue file save previously rendered and rewrote every generated POM, including
when the edit did not change any generated content. This benchmark reproduces
that behavior through a real Vite watcher and checks the fix.

## Run

```sh
npm ci
npm run build
node --expose-gc scripts/repro-hmr-regeneration.mjs 645 10
node --expose-gc scripts/repro-hmr-regeneration.mjs 645 10 --disabled
```

The script imports the built package by name, creates 645 independent Vue
components with 10 button handlers each in a temporary directory, and starts a
real Vite server. It saves `Widget0.vue` twice: once changing only button text,
then renaming one handler. Actual filesystem events invoke Vite's HMR hooks;
the generator and its hooks are not mocked or invoked manually. Fixtures and
generated outputs are removed when the script finishes.

Generation includes split TypeScript Playwright POMs, fixtures, C#, and Vue Test
Utils POMs. The components are synthetic; the harness has no application router,
custom helpers, browser, or IDE. Separate regression tests cover dependent
parents, slot projections, routing, custom helpers, and aggregated output.

To measure an unpatched version, copy the script into a checkout of that version,
build it, and run with `--expect-full-regeneration`. That flag asserts the old
behavior instead of the fixed behavior. Each run prints a final `RESULT` JSON
line with phase timings, output counts, CPU time, and memory observations.

## Before and after

Measured on the same macOS machine with Node 22.22.2, Vite 7.3.1, Vue 3.5.27,
`@vitejs/plugin-vue` 6.0.3, and ts-morph 27.0.2. The baseline is commit `2f6667e`;
the fixed run uses the changes accompanying this document. These are individual
runs, not statistical averages.

| Phase | Before elapsed | After elapsed | Before output writes | After output writes | Before peak RSS | After peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Startup | 11.15 s | 9.92 s | 1,305 | 1,305 | 810.0 MiB | 564.9 MiB |
| Button-label edit | 2.55 s | 0.40 s | 1,305 | 0 | 908.1 MiB | 454.2 MiB |
| Handler rename | 2.63 s | 0.71 s | 1,305 | 5 | 950.6 MiB | 566.3 MiB |

Both versions read only one Vue source file per edit. Before the fix, the label
edit rewrote 1,305 identical outputs, and the handler rename rewrote 1,300
identical outputs. After the fix, neither edit writes identical output. Only one
Playwright component POM is rewritten for the handler rename; unrelated
component POMs remain untouched.

RSS is sampled every 5 ms by a separate worker so synchronous generation cannot
block sampling. It includes the worker's memory and is total process size, not
bytes allocated per save. Label-edit RSS started at 744.3 MiB before the fix and
415.5 MiB after it; handler-edit RSS started at 786.3 MiB and 416.8 MiB respectively.
The script retains generated text to compare output contents, adding measurement
overhead. Heap observations are taken at filesystem operations and phase
boundaries and are lower bounds on the peak. These results do not establish a
memory leak or guarantee the same timings in an application.

No browser loads modules in this harness. `--disabled` measures Vite startup and
delivery of the file-change hook, not application rendering or browser HMR
completion.

## Cause and fix

The dev plugin recompiles only changed Vue files, then generates from the full
component snapshot. Previously, TypeScript rendering created a new ts-morph
project for every output and repeatedly reparsed it as class members were added.
The ownership writer then atomically replaced every output regardless of content.

Generation now prepares complete TypeScript source structures and creates each
uncached source file in one operation. A cache owned by each dev server keeps
one resolved input and rendered string per output, without retaining ASTs. The
input includes rendered writer callbacks, so changed captured selectors, routes,
child methods, and custom helper signatures invalidate the affected output.
Entries for removed outputs are pruned after successful generation.

The cache compares fully resolved output structures rather than just the edited
component's source. Parent dependencies and shared exports are still recomputed
from the current snapshot before deciding whether their AST needs rebuilding.
The rich POM manifest uses the same cache. The writer compares generated text
against the file on disk before replacing it, preserving timestamps for unchanged
outputs while still repairing deleted or externally modified files.

This avoids repeated TypeScript AST construction and filesystem churn. Semantic
preparation still walks the component snapshot, and shared C# output is still
rendered on each pass. An aggregated TypeScript output is rebuilt as a whole when
its resolved structure changes. Startup still compiles every source component.
