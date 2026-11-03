# S8: code-test sandbox for `tests` criteria

Measured on 2026-11-03 on macOS (Apple silicon), Node 24.21.0, quickjs-emscripten 0.32.0 (QuickJS 2025-09-13, the `release-sync` WebAssembly build). The question (spec 12.1): is a hostile snippet (network, fork bomb, infinite loop) contained? The fallback if not: ship kinds 1 to 3 and drop `tests`.

## Verdict

Contained, with three findings that changed the implementation or the claim. The `tests` kind stays.

1. **The engine's memory limit did not bound memory.** It does now (`sandbox.ts`, `ENGINE_MEMORY_CAP_BYTES`, 128 MiB). Found by the memory bomb; without the fix this case was an escape from its memory limit, and the kill switch would have applied.
2. **The engine cannot interrupt a native built-in that loops on its own.** One such entry ends at the score worker's hard stop (5 s), not at the case's 1 s. That is the Judge's existing second wall (P05-R1), it holds, and it is the reason a `tests` entry must never be scored on the Judge's own thread. See "What the sandbox does not do".
3. **With one engine shared by every entry, an entry's score depended on the entries scored before it** (found in review of the first version, whose cap was 64 MiB). Each entry now has an engine of its own, and the cap is 128 MiB. See "Finding 3".

## How an entry runs

An entry is JavaScript source (at most 65_536 bytes) defining the function `criteria.entry`. For each case the Judge runs, in a QuickJS sandbox that belongs to this entry alone (`new Sandbox()`, its own engine), a fresh runtime with 1_000 ms and a 32 MiB memory limit:

```
<source>
;JSON.stringify((<entry>)(<input as a JSON literal>))
```

The host parses the resulting string and compares it with the case's `output` as JSON (key order does not matter). `entry` has to be a plain function name (intake checks it, `scoreTests` checks it again), and the input is JSON, so no text of an entry or a task is ever code except the entry's own source. What a case that runs out of its limits costs the entry is in "Scoring a case that runs out of time or memory".

There are three walls, innermost first:

| wall | what it bounds | what it does not |
|---|---|---|
| QuickJS interrupt handler, 1 s per case | bytecode: loops, recursion, regex backtracking, `toJSON`, getters, proxies, code that runs while the value is read | a native built-in looping on its own |
| WebAssembly memory cap, 128 MiB for the engine (`ENGINE_MEMORY_CAP_BYTES`) | all allocation, however it is split into blocks | |
| score worker, 5 s per entry, then `worker.terminate()` (`isolate.ts`) | everything, including native loops; the entry scores 0 (`scoring timed out`) and a new worker takes the next entry | |

## Finding 1: the 32 MiB limit

QuickJS counts memory through `malloc_usable_size`, which this build does not have (`dumpMemoryUsage` says `malloc_usable_size unavailable`). It adds only a few bytes for each allocation, and checks a request against the limit by itself. So `setMemoryLimit(32 MiB)` stops one block bigger than that and no more: any number of smaller blocks is allowed. WebAssembly memory only grows, so the memory an entry takes is kept by the engine for the life of the thread.

Before the fix, the memory bomb `const a = []; while (true) a.push(new Array(1000).fill(0))` with a 3 s time limit:

| | wasm memory | process RSS | time |
|---|---|---|---|
| start | 16 MiB | 72 MiB | |
| after the bomb | 1,283 to 1,572 MiB (two runs) | 1,188 to 1,299 MiB | 3.5 to 7.2 s for a 3 s limit |

With the sandbox's own 1 s limit the bombs ended at `timeout` or `memory` after 1.2 to 3.2 s (`a.push(new Array(1e6).fill(0))`: 2.8 s; `a.push(("x" + i).repeat(1e5))`: 3.2 s), taking memory at roughly 0.4 GiB a second. The case limit of 1.2 s was not held. The existing test `memory_bomb_contained` could not show this: it ends because the list it pushes to outgrows the limit as one block, which the limit does stop.

The fix gives the engine a `WebAssembly.Memory` with a maximum (128 MiB, 2,048 pages; the module starts at 16 MiB. Why 128 is under "Finding 3"). When the memory cannot grow, QuickJS's allocation fails and the run ends in the engine's out-of-memory error, like any allocation over the limit. What the run held is freed with its runtime. After the fix, each bomb on a new engine with a 1 s limit:

| bomb | time to end | result |
|---|---|---|
| `a.push(new Array(1000).fill(0))` | 139 ms | `memory` |
| `a.push({a: 1, b: [1]})` | 297 ms | exception (`null`: no memory left for the error) |
| `a.push(new Array(1e6).fill(0))` | 111 ms | `memory` |
| `a.push(("x" + i).repeat(1e5))` | 273 ms | `memory` |
| `a.push("y".repeat(1000) + i)` | 321 ms | `memory` |

Test: `the_sandbox_engine_cannot_be_grown_past_its_cap_by_many_small_allocations` (it took 6.7 s and failed before the fix, 0.2 s after). The change is in the shared `sandbox.ts`, so `regex_cases` runs on the capped engine too; its tests and the sandbox tests pass unchanged.

## Finding 3: an entry's score depended on the entries before it

The first version of the fix capped one engine for the whole thread at 64 MiB and shared it by every run. Review found that an engine's capacity then depended on what had run on it: a fresh 64 MiB engine refused an honest array of 19 MB (`new Array(2_500_000).fill(1)`, under the case's 32 MiB), where one that earlier runs had warmed accepted it. In a score worker the same honest entry scored:

| entry scored before it in the worker | honest entry's score |
|---|---|
| nothing (first entry) | 0 (`ran out of memory`) |
| a memory bomb | 100 |
| a native loop (worker stopped, a new worker) | 0 |
| a small honest entry | 0 |

So a hostile entry could raise or sink another entry's score, and a third party re-running an entry on a fresh engine got another score than the Judge. Two changes:

- **An engine for each entry.** `scoreTests` makes a `Sandbox` (`sandbox.ts`: an engine and the runs on it, with `renew()` to drop the engine) for each entry. `runInSandbox`, which `regex_cases` uses, runs on one `Sandbox` shared by every caller, as before. A new engine costs 1 to 9 ms to load; 400 honest entries of 4 cases took 3.1 ms each, and the process stayed at 113 to 122 MiB (an engine and its memory are freed when its entry is done). Entries whose cases all run out of memory took 680 ms each (4 × about 170 ms), at 195 MiB.
- **A cap of 128 MiB**, so that the case's 32 MiB limit on one block is what binds. On a fresh engine, per cap:

| honest run | 64 MiB | 96 MiB | 128 MiB |
|---|---|---|---|
| `new Array(n).fill(1)`, n = 2.5M, 3M, 3.5M (19 to 27 MiB) | out of memory | ok | ok |
| the same with n = 3.9M or 4.1M (the block grows to over 32 MiB) | out of memory | out of memory | out of memory |
| a 27 MiB array grown by `push`, 3.5M times | out of memory | ok | ok |
| a 27 MiB array and a `map` copy of it | out of memory | ok | ok |
| a 27 MiB array and three copies | | | ok (409 ms) |

The 96 MiB column ends where the limit on one block ends, but leaves no room for a third live block; 128 MiB admits an array just under the limit and three copies, at the price of a bomb taking 0.11 to 0.32 s to reach the cap and not 0.08 to 0.24 s. With 128 MiB, a honest big allocation also succeeds right after any bomb on the same engine (checked for five kinds of bomb), so the engine's layout no longer decides anything.

Test: `the_same_honest_entry_scores_the_same_first_after_a_bomb_and_after_a_worker_kill` scores the 19 MB entry in one score worker first, after a small entry, after two bombs and after a native loop whose worker is stopped, and expects 100 each time (the first version scored 0 for the first one).

## Scoring a case that runs out of time or memory

Ruled on by the controller after review (Task 6 fix round 1):

- **Time.** A case that runs out of its second ends the run: the cases after it are not run and count as failed. The score is over all the cases, `round(100 × passed / total)`, with `total` the number of cases, and the reasons end with `N more cases not run`. That bounds a looping entry to about 1 s and not 1 s for each case. An honest entry that crosses 1 s once, on a loaded host, loses the cases after it, so task authors should keep each case far below a second (the reference solution's whole run should stay well under 2 s on the Judge host).
- **Memory.** A case that runs out of memory fails alone. The cases after it run, on a new engine, and an out-of-memory case never zeroes an entry: 1 of 5 cases bombing scores 80. An entry whose every case bombs costs about 0.15 s a case (0.6 s for 4 cases), so with many cases it runs into the worker's 5 s and scores 0 (`scoring timed out`).

The code has the rule where the run is decided (`kinds/tests.ts`), and the tests are `a_case_that_times_out_ends_the_run_and_the_cases_after_it_count_as_failed` and `a_case_that_runs_out_of_memory_does_not_zero_the_entry`.

## The hostile entries

Each entry is in `packages/judge/test/tests_kind.test.ts` (`hostile_*`), run on 4 cases (so the bound is 4 × 1.2 s = 4.8 s). The entries that try to reach the host are written so that if the attempt worked the entry would answer correctly (a 100) or leave a file behind; the file is a canary in a temporary directory, and it was absent every time. The time is for the whole entry, engine and first-run costs included. Every entry scored 0 and none failed the Judge.

The six the brief names:

| hostile entry | what happened | score | time |
|---|---|---|---|
| infinite loop, `while (true) {}` | engine interrupt: `interrupted after 1000 ms`; case 1 `timed out`, the other 3 not run | 0 | 1.02 s |
| memory bomb (four forms below) | see below | 0 | 4 ms to 1.4 s |
| deep recursion, `f(x + 1) + 1` | `RangeError: Maximum call stack size exceeded` in every case | 0 | 10 ms |
| `import("fs")` | returns a promise that is never settled by the scorer (the function's answer is `{}`: wrong output). With the job queue run by hand, it is refused: `ReferenceError: could not load module 'node:fs'` (also for `fs`, and for a `data:` module) | 0 | 2 ms |
| `require("child_process")` | `ReferenceError: 'require' is not defined` | 0 | 1 ms |
| `globalThis.constructor.constructor("return process")()` | `ReferenceError: 'process' is not defined` (the `Function` constructor makes code in the same engine, and the engine has no `process`) | 0 | 1 ms |

The memory bomb forms, each now run on all 4 cases (an out-of-memory case does not end the run): arrays in a loop (`ran out of memory` in every case, each on a new engine, 0.83 s); objects in a loop (`ran out of memory`, 1.4 s); string doubling `s += s` (`InternalError: string too long`, 4 ms); one block, `new Array(1e9).fill(0)` (`ran out of memory`, 0.15 s).

More that were tried, all contained:

| hostile entry | what happened | score | time |
|---|---|---|---|
| recursion through a 1,000,000-deep array, then `JSON.stringify` | exception (`null` or stack overflow) | 0 | 1.05 s |
| `/^(a+)+$/` on `"aaa…!"` (40 characters) | regex engine polls the interrupt: `timed out` | 0 | 1.00 s |
| `require("fs").writeFileSync`, `process.mainModule.require`, `(0, Function)("return process.pid")()`, `this.process` in a sloppy function | `process` and `require` do not exist; canary absent | 0 | 1 to 4 ms |
| `fetch(...)`, `setTimeout`, `setInterval`, `WebAssembly`, `Atomics`, `Worker`, `MessageChannel` | none of them exist (`typeof` is `undefined`) | 0 | 1 to 6 ms |
| `toJSON() { while (true) {} }`, a getter that loops, a `Proxy` whose `ownKeys` loops (all run while the answer is read) | interrupted; the sandbox counts the run as a timeout | 0 | 1.00 to 1.01 s |
| `for (;;) { try { while (true) {} } catch (e) {} }` | the interrupt cannot be caught | 0 | 1.00 s |
| the same around a memory bomb (`catch (e) {}`) | stops at the deadline | 0 | 1.01 s |
| a 30 MiB string as the answer | `ran out of memory` in every case | 0 | 0.76 s |
| 1,000,000 `Promise.resolve().then(...)` | exception (`null`) | 0 | 2.3 s |
| `JSON.stringify = () => "2"` | the entry writes its own output string, and gets the cases whose expected output it happens to equal (1 of 4); it cannot read the expected values | 25 | 6 ms |

The raw outcome of each, as the sandbox reports it, is in the table above; `scoreTests` shows only `timed out`, `ran out of memory`, `threw an exception`, `wrong output`, `no JSON output` or `output too large` in the reasons, never text the entry wrote.

## What the sandbox does not do

**Native loops.** The interrupt handler is polled between bytecodes. Built-ins that loop over the length of an array without running JavaScript never reach it, and a sparse array can have a length of 4 billion at no cost in memory:

| entry | result in the sandbox alone |
|---|---|
| `new Array(2 ** 32 - 1).indexOf(1)` | killed by my driver after 20 s, still running |
| `.lastIndexOf(1)`, `.includes(1)`, `.join("a")`, `.join("")`, `.reverse()`, `.sort()`, `.slice()`, `.splice(0)`, `.map(x => x)`, `.forEach(...)`, `[].concat(...)` | the same |

(`Array.prototype.fill`, `Array.from({length})` and `Object.keys` of such an array end within 0.3 s, by memory or by returning. `JSON.stringify` of one, which every answer goes through, ends when the string it builds passes the memory limit: 0.99 s here, and so the speed of the machine.) Through the Judge's score worker each of the five tried was ended at 5.00 s by the worker's stop: score 0 with the reason `scoring timed out`, and the next entry scored 100 by a new worker 120 to 210 ms later. Only one worker was alive after each, and a bare worker used 1 ms of CPU in the 1.5 s after its stop. `worker.terminate()` does stop WebAssembly in the middle of such a loop (21 ms in a bare worker after 3 s of it). So they are contained by the score worker, at its limit, not the case's. Two consequences:

- `scoreTests` blocks its thread for as long as such an entry runs. It must not be called on the Judge's own thread; the Judge calls it only through `prepareScorer` in a score worker, as for every kind.
- An entry can cost the Judge 5 s of one worker (not of the Judge's thread), not 1 s. `regex_cases` and `json_schema` entries have the same 5 s wall already (an Ajv pattern that backtracks without end takes it). A task with many such entries uses its judging time on them; the stop line (P05-R15) still holds, and entries it cuts are not scored.

**Slow failures.** A case that fails without timing out (a stack overflow takes 20 to 190 ms, an out-of-memory case about 0.15 s) does not end the run, so an entry that fails every case slowly can use up the worker's 5 s with many cases and score 0 (`scoring timed out`) and not partial credit. A task with 4 cases is not affected; with many cases it is.

**Determinism.** `Date`, `Math.random` and `Date.now` are live, and `Date` follows the Judge host's time zone (`new Date(0).toString()` reads `GMT+0100` here). Task authors should not test them. The shared QuickJS runtime has no `Intl` (`toLocaleString` is plain), `structuredClone`, `console` or timers, so an entry that uses them throws. Async functions return a promise, which JSON writes as `{}`: the function must return its answer. A recursion 20,000 frames deep throws (the stack is 1 MiB). A regex is QuickJS's: it refuses 256 capture groups (`too many captures`), where V8 allows far more. `SharedArrayBuffer` exists (plain memory in the engine; there are no threads and no `Atomics`).

**Memory is fakeable only downwards.** The label `memory` can be produced by code that throws the engine's error. That case fails, as it would anyway, and costs the Judge a new engine (a few milliseconds).

## Decision

Kill switch not applied: after the memory cap and the engine for each entry, every case above is contained in the sandbox or by the score worker, the six the brief names inside the 4.8 s bound. If the 5 s native-loop cost is not acceptable, the switch is two lines in `intake.ts` (reject `tests` from the team as `kind tests is not available yet`, as before this change).
