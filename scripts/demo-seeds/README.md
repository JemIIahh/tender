# Demo tasks

Four small tasks for the **demo**: `pnpm demo:local`, the CI `demo` job and the end-to-end stack
post them to a **local chain** (the NEAR sandbox this repository starts for itself) and nowhere
else. They are **demo-only**: never post them to testnet or mainnet, and nothing here is a real
bounty.

They exist so that a clean checkout can run the whole demo with nothing set up. The 30 real seeds
in `seeds/` keep everything answer-like (held-out checks, solutions, weak answers) out of the
repository (see `seeds/README.md`), because a published solution would win the real task. These tasks are the
opposite on purpose: each one is complete in its folder, with its brief, criteria, held-out
checks, a correct answer and a weak one all in the open. Their content and answers are different
from the real seeds', and `scripts/demo-seeds.test.ts` checks that the two sets share none.

| Task                         | Kind of check | What it asks for                                 |
| ---------------------------- | ------------- | ------------------------------------------------ |
| `demo-room-code-regex`       | `regex_cases` | one regex for hotel room codes such as `C3-045`  |
| `demo-divisor-counts`        | `exact`       | how many divisors each of eight numbers has      |
| `demo-dispatch-note-extract` | `json_schema` | a courier dispatch note, read into JSON          |
| `demo-run-length-code`       | `tests`       | `rle(text)`, a run-length encoder, as JavaScript |

Every task says it is demo-only in its title (`Demo: ...`), in its tags (`demo-only`) and in the
last paragraph of its instructions.

A task is a folder in the seed format:

| File            | What it is                                                                 |
| --------------- | -------------------------------------------------------------------------- |
| `task.json`     | reward, token, windows, winners, verifier                                  |
| `brief.json`    | what the solver is shown: instructions, output format and size             |
| `criteria.json` | how it is scored, and the public examples                                  |
| `heldout.json`  | the checks kept back until the result is announced (here in the open)      |
| `solution.txt`  | a correct answer: the scripted `alice` of the demo enters it               |
| `weak.txt`      | a plausible answer that misses the pass mark: the scripted `bob` enters it |

`pnpm demo:local` posts `demo-room-code-regex`, reads its held-out checks from this folder, and
lets `alice` win with the solution while `bob`'s weak answer scores under 100. With `--keep` it
also posts `demo-divisor-counts`, open for half an hour, for an agent of the MCP server to enter. It needs no private
directory, no key and no network.
