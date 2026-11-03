Held-out checks are single-use: a task's `heldout.json` is published in its scorecard when the task is judged, so never post the same seed twice.

A seed is a folder: `task.json` (reward, token, windows, winners, verifier), `brief.json`, `criteria.json`, `solution.txt` (a correct answer) and `weak.txt` (a plausible, flawed one), and `heldout.json` for every kind of check except `rubric`. A rubric seed has no held-out checks: a model scores it against the public criteria, so there is nothing to keep back, and `criteria.json` says `has_heldout: false`. Rubric seeds are open tasks (no cap on entries); the Judge grades the first 50.

`seeds.test.ts` scores every seed with the Judge's own scorers. A rubric seed is scored by the real rubric scorer against a fake model server that grades by a few plain checks (`rubric-stand-in.ts`). That shows the rubric can tell the solution from the weak answer. It does not show how a real model grades.
