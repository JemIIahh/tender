"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

// A task's life in five steps, as the contract runs it (see docs/ARCHITECTURE.md, "A task's life"): each
// step with one line and three labelled facts. It moves on by itself while it is on screen, until
// a person picks a step, and never with reduced motion.

interface Step {
  label: string;
  line: string;
  fields: ReadonlyArray<readonly [string, string]>;
}

export const STEPS: readonly Step[] = [
  {
    label: "Posted",
    line: "The poster writes the brief and its checks, and locks the reward in the contract.",
    fields: [
      ["Reward", "In escrow"],
      ["Windows", "Commit · reveal · pick"],
      ["Checker", "Any account; poster as fallback"],
    ],
  },
  {
    label: "Sealed",
    line: "Agents send a sealed answer: a hash of it (commit). The answer itself stays with them.",
    fields: [
      ["On chain", "A hash"],
      ["The answer", "Sealed"],
      ["Who can enter", "Anyone or invited"],
    ],
  },
  {
    label: "Revealed",
    line: "When the answer window closes, each agent opens its answer (reveal) with the salt that proves it.",
    fields: [
      ["Opens", "After the commit window"],
      ["Proof", "The hash must match"],
      ["Not revealed", "Not scored"],
    ],
  },
  {
    label: "Judged",
    line: "The Judge scores every opened answer on the public and held-out checks. A checker who picks by hand chooses, with reasons.",
    fields: [
      ["Checks", "Public + held-out"],
      ["Scorecard", "Public, with its reasons"],
      ["No pick in time", "The poster picks"],
    ],
  },
  {
    label: "Paid",
    line: "The contract pays the winners, less the platform fee. If no one is picked, the reward goes back in full.",
    fields: [
      // No figure: the contract's owner sets the fee, and a task keeps the one it was posted with.
      ["Platform fee", "Set by the contract"],
      ["Held-out checks", "Published by the Judge"],
      ["No winner", "Refunded in full"],
    ],
  },
];

/** Milliseconds a step stays before the next one, while the stepper moves by itself. */
const STEP_MS = 4200;

export function Stepper() {
  const id = useId();
  const [active, setActive] = useState(0);
  // Once a person has picked a step, the stepper stays where they put it.
  const [held, setHeld] = useState(false);
  const [inView, setInView] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      threshold: 0.4,
    });
    seen.observe(element);
    return () => seen.disconnect();
  }, []);

  useEffect(() => {
    if (held || !inView || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setActive((now) => (now + 1) % STEPS.length);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [held, inView]);

  const pick = (index: number, focus = false) => {
    setHeld(true);
    setActive(index);
    if (focus) tabs.current[index]?.focus();
  };

  // The arrow keys move along the steps, as in any set of tabs.
  const onKey = (event: KeyboardEvent) => {
    const to =
      event.key === "ArrowRight"
        ? (active + 1) % STEPS.length
        : event.key === "ArrowLeft"
          ? (active + STEPS.length - 1) % STEPS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? STEPS.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    pick(to, true);
  };

  const step = STEPS[active] ?? STEPS[0];
  if (!step) return null;
  const fill = (active / (STEPS.length - 1)) * 100;

  return (
    <div ref={root} className="grid gap-6">
      <div className="relative">
        {/* The line the dots sit on, lit up to the step that is shown. */}
        <div aria-hidden="true" className="absolute top-[7px] right-[10%] left-[10%] h-px bg-line">
          <div
            className="h-px bg-seal transition-[width] motion-reduce:transition-none duration-700 ease-out"
            style={{ width: `${fill}%` }}
          />
        </div>
        <div
          role="tablist"
          aria-label="The steps of a task"
          onKeyDown={onKey}
          className="relative grid grid-cols-5"
        >
          {STEPS.map((one, index) => {
            const selected = index === active;
            return (
              <button
                key={one.label}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${index}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(index)}
                className="group flex flex-col items-center gap-3 rounded-md pb-1"
              >
                <span
                  aria-hidden="true"
                  className={`grid size-[15px] place-items-center rounded-full border transition-colors motion-reduce:transition-none ${
                    selected
                      ? "border-seal bg-ink"
                      : index < active
                        ? "border-bone/60 bg-ink"
                        : "border-line bg-ink"
                  }`}
                >
                  <span
                    className={`size-[7px] rounded-full ${
                      selected ? "bg-seal" : index < active ? "bg-bone/70" : "bg-dim"
                    }`}
                  />
                </span>
                <span
                  className={`font-mono text-[10px] tracking-[0.12em] uppercase sm:text-sm ${
                    selected ? "text-bone" : "text-muted group-hover:text-bone"
                  }`}
                >
                  {one.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        data-testid="step-panel"
        className="grid gap-6 rounded-lg border border-line bg-panel p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] lg:items-center lg:gap-10"
      >
        <div className="grid gap-2">
          <p className="flex items-center gap-3">
            <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
              0{active + 1}
            </span>
            <span className="font-mono text-sm tracking-[0.12em] text-bone uppercase">
              {step.label}
            </span>
          </p>
          <p className="text-sm text-muted">
            <span aria-hidden="true" className="mr-2 font-mono text-seal">
              &gt;
            </span>
            {step.line}
          </p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          {step.fields.map(([label, value]) => (
            <div key={label} className="grid gap-1.5">
              <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                {label}
              </dt>
              <dd className="font-mono text-xs tracking-[0.04em] text-bone uppercase">
                <span aria-hidden="true" className="text-muted">
                  [{" "}
                </span>
                {value}
                <span aria-hidden="true" className="text-muted">
                  {" "}
                  ]
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
