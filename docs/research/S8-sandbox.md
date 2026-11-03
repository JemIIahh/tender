# S8: code-test sandbox for `tests` criteria

Measured on 2026-11-03 on macOS (Apple silicon), Node 24.21.0, quickjs-emscripten 0.32.0 (QuickJS 2025-09-13, the `release-sync` WebAssembly build). The question (spec 12.1): is a hostile snippet (network, fork bomb, infinite loop) contained? The fallback if not: ship kinds 1 to 3 and drop `tests`.

## Verdict

Contained, with two findings that changed the implementation or the claim. The `tests` kind stays.

1. **The engine's memory limit did not bound memory.** It does now (`sandbox.ts`, `ENGINE_MEMORY_CAP_BYTES`). Found by the memory bomb; without the fix this case was an escape from its memory limit, and the kill switch would have applied.
2. **The engine cannot interrupt a native built-in that loops on its own.** One such entry ends at the score worker's hard stop (5 s), not at the case's 1 s. That is the Judge's existing second wall (P05-R1), it holds, and it is the reason a `tests` entry must never be scored on the Judge's own thread. See "What the sandbox does not do".

## How an entry runs

An entry is JavaScript source (at most 65_536 bytes) defining the function `criteria.entry`. For each case the Judge runs, in the shared QuickJS sandbox (`runInSandbox`), a fresh runtime with 1_000 ms and a 32 MiB memory limit:

```
<source>
;JSON.stringify((<entry>)(<input as a JSON literal>))
```

The host parses the resulting string and compares it with the case's `output` as JSON (key order does not matter). `entry` has to be a plain function name (intake checks it, `scoreTests` checks it again), and the input is JSON, so no text of an entry or a task is ever code except the entry's own source. A case that times out or runs out of memory ends the run, and the cases after it count as failed.

There are three walls, innermost first:

| wall | what it bounds | what it does not |
|---|---|---|
| QuickJS interrupt handler, 1 s per case | bytecode: loops, recursion, regex backtracking, `toJSON`, getters, proxies, code that runs while the value is read | a native built-in looping on its own |
| WebAssembly memory cap, 64 MiB for the engine (`ENGINE_MEMORY_CAP_BYTES`) | all allocation, however it is split into blocks | |
| score worker, 5 s per entry, then `worker.terminate()` (`isolate.ts`) | everything, including native loops; the entry scores 0 (`scoring timed out`) and a new worker takes the next entry | |

## Finding 1: the 32 MiB limit

QuickJS counts memory through `malloc_usable_size`, which this build does not have (`dumpMemoryUsage` says `malloc_usable_size unavailable`). It adds only a few bytes for each allocation, and checks a request against the limit by itself. So `setMemoryLimit(32 MiB)` stops one block bigger than that and no more: any number of smaller blocks is allowed. WebAssembly memory only grows, so the memory an entry takes is kept by the engine for the life of the thread.

Before the fix, the memory bomb `const a = []; while (true) a.push(new Array(1000).fill(0))` with a 3 s time limit:

| | wasm memory | process RSS | time |
|---|---|---|---|
| start | 16 MiB | 72 MiB | |
| after the bomb | 1,283 to 1,572 MiB (two runs) | 1,188 to 1,299 MiB | 3.5 to 7.2 s for a 3 s limit |

With the sandbox's own 1 s limit the bombs ended at `timeout` or `memory` after 1.2 to 3.2 s (`a.push(new Array(1e6).fill(0))`: 2.8 s; `a.push(("x" + i).repeat(1e5))`: 3.2 s), taking memory at roughly 0.4 GiB a second. The case limit of 1.2 s was not held. The existing test `memory_bomb_contained` could not show this: it ends because the list it pushes to outgrows the limit as one block, which the limit does stop.

The fix gives the engine a `WebAssembly.Memory` with a maximum of 64 MiB (1,024 pages; the module starts at 16 MiB). When the memory cannot grow, QuickJS's allocation fails and the run ends in the engine's out-of-memory error, like any allocation over the limit. What the run held is freed with its runtime and is there for the next run. After the fix:

| bomb | time to end | result | wasm memory after |
|---|---|---|---|
| `a.push(new Array(1000).fill(0))` | 127 ms | `memory` | 63 MiB |
| `a.push({a: 1, b: 2, c: 3})` | 250 ms | exception (`null`: no memory left for the error) | 63 MiB |
| `a.push(new Array(1e6).fill(0))` | 53 ms | `memory` | 63 MiB |
| `a.push(("x" + i).repeat(1e5))` | 143 ms | `memory` | 63 MiB |
| an honest run after them | 1 ms | `[2,4,6]` | 63 MiB |

Test: `the_sandbox_engine_cannot_be_grown_past_its_cap_by_many_small_allocations` (it took 6.7 s and failed before the fix, 0.4 s after). The change is in the shared `sandbox.ts`, so `regex_cases` runs on the capped engine too; its tests and the sandbox tests pass unchanged. The 64 MiB is 16 MiB for the module, 32 MiB for the largest block an entry may ask for, and headroom; nothing an honest function needs comes near it.

## The hostile entries

Each entry is in `packages/judge/test/tests_kind.test.ts` (`hostile_*`), run on 4 cases (so the bound is 4 × 1.2 s = 4.8 s). The entries that try to reach the host are written so that if the attempt worked the entry would answer correctly (a 100) or leave a file behind; the file is a canary in a temporary directory, and it was absent every time. The time is for the whole entry, engine and first-run costs included. Every entry scored 0 and none failed the Judge.

The six the brief names:

| hostile entry | what happened | score | time |
|---|---|---|---|
| infinite loop, `while (true) {}` | engine interrupt: `interrupted after 1000 ms`; case 1 `timed out`, the other 3 not run | 0 | 1.02 s |
| memory bomb (four forms below) | see below | 0 | 2 ms to 0.67 s |
| deep recursion, `f(x + 1) + 1` | `RangeError: Maximum call stack size exceeded` in every case | 0 | 23 ms |
| `import("fs")` | returns a promise that is never settled by the scorer (the function's answer is `{}`: wrong output). With the job queue run by hand, it is refused: `ReferenceError: could not load module 'node:fs'` (also for `fs`, and for a `data:` module) | 0 | 2 ms |
| `require("child_process")` | `ReferenceError: 'require' is not defined` | 0 | 1 ms |
| `globalThis.constructor.constructor("return process")()` | `ReferenceError: 'process' is not defined` (the `Function` constructor makes code in the same engine, and the engine has no `process`) | 0 | 1 ms |

The memory bomb forms: arrays in a loop (`ran out of memory`, 92 ms, run ended after case 1); objects in a loop (exception, 670 ms, all 4 cases run: the engine has no memory left to build the error and throws `null`); string doubling `s += s` (`InternalError: string too long`, 2 ms); one block, `new Array(1e9).fill(0)` (`out of memory`, 39 ms).

More that were tried, all contained:

| hostile entry | what happened | score | time |
|---|---|---|---|
| recursion through a 1,000,000-deep array, then `JSON.stringify` | exception (`null` or stack overflow) | 0 | 0.78 s |
| `/^(a+)+$/` on `"aaa…!"` (40 characters) | regex engine polls the interrupt: `timed out` | 0 | 1.00 s |
| `require("fs").writeFileSync`, `process.mainModule.require`, `(0, Function)("return process.pid")()`, `this.process` in a sloppy function | `process` and `require` do not exist; canary absent | 0 | 1 to 4 ms |
| `fetch(...)`, `setTimeout`, `setInterval`, `WebAssembly`, `Atomics`, `Worker`, `MessageChannel` | none of them exist (`typeof` is `undefined`) | 0 | 1 to 6 ms |
| `toJSON() { while (true) {} }`, a getter that loops, a `Proxy` whose `ownKeys` loops (all run while the answer is read) | interrupted; the sandbox counts the run as a timeout | 0 | 1.00 to 1.01 s |
| `for (;;) { try { while (true) {} } catch (e) {} }` | the interrupt cannot be caught | 0 | 1.00 s |
| the same around a memory bomb (`catch (e) {}`) | stops at the deadline | 0 | 1.01 s |
| a 30 MiB string as the answer | `out of memory` | 0 | 0.35 s |
| 1,000,000 `Promise.resolve().then(...)` | exception (`null`) | 0 | 1.2 s |
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

**Slow failures.** A case that fails without timing out or running out of memory (a stack overflow takes 20 to 190 ms) does not end the run, so an entry that fails every case slowly can use up the worker's 5 s with many cases and score 0 (`scoring timed out`) and not partial credit. Tasks with few cases (5 to 50) are not affected.

**Determinism.** `Date`, `Math.random` and `Date.now` are live, and `Date` follows the Judge host's time zone (`new Date(0).toString()` reads `GMT+0100` here). Task authors should not test them. The shared QuickJS runtime has no `Intl` (`toLocaleString` is plain), `structuredClone`, `console` or timers, so an entry that uses them throws. Async functions return a promise, which JSON writes as `{}`: the function must return its answer. A recursion 20,000 frames deep throws (the stack is 1 MiB). A regex is QuickJS's: it refuses 256 capture groups (`too many captures`), where V8 allows far more. `SharedArrayBuffer` exists (plain memory in the engine; there are no threads and no `Atomics`).

**Memory is fakeable only downwards.** The label `memory` can be produced by code that throws the engine's error, which ends only its own run early (a lower score for that entry).

## Decision

Kill switch not applied: after the memory cap, every case above is contained in the sandbox or by the score worker, the six the brief names inside the 4.8 s bound. If the 5 s native-loop cost is not acceptable, the switch is two lines in `intake.ts` (reject `tests` from the team as `kind tests is not available yet`, as before this change).
