import type { TaskAttestation } from "@tender/shared";
import { attestedModels, signatureCount } from "../lib/attested";
import { FACT_LABEL, FACTS, PANEL, PANEL_TITLE } from "./ui";

/** The id of the panel, which the Checker card's mark links to. */
export const ATTESTED_ID = "attested";

/**
 * The small mark on the Checker card of a task that was settled with `pick_attested`: the dot of a
 * live service, and the words, linking to the panel below. It takes the colour of the text around it.
 */
export function AttestedChip({ count }: { count: number }) {
  return (
    <a
      data-testid="attested-chip"
      href={`#${ATTESTED_ID}`}
      className="inline-flex w-fit items-center gap-2 rounded-full border border-current/30 px-2.5 py-1 text-[12px] leading-none font-medium transition-colors hover:border-bone/60 motion-reduce:transition-none"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ok" />
      TEE-attested
      <span className="sr-only">{`: the contract checked ${signatureCount(count)} before it paid`}</span>
    </a>
  );
}

/**
 * What the contract checked before it paid a task that was settled with `pick_attested`, and how a
 * reader checks it again. The rows are the task's `attested_pick` events: the signer, the model it
 * was registered for, and the SHA-256 of the exact request and response the signature covers.
 *
 * It says what the mark does not show as plainly as what it does (docs/LIMITS.md, "TEE limits"):
 * the contract checks that a registered key signed those hashes, it cannot check the hardware
 * attestation, and nothing here says the score is right.
 */
export function AttestedMark({
  attestations,
  command,
}: {
  attestations: readonly TaskAttestation[];
  /** The command that checks the task again (`verifyCommand`). */
  command: string;
}) {
  const models = attestedModels(attestations);
  const many = attestations.length !== 1;
  return (
    <section id={ATTESTED_ID} data-testid="attested" className={`${PANEL} scroll-mt-24`}>
      <h2 className={PANEL_TITLE}>TEE-attested</h2>
      <p data-testid="attested-summary" className="text-sm text-bone wrap-anywhere">
        {`Before it paid, the contract checked ${signatureCount(attestations.length)}, each from a signer its owner registered for ${models.join(", ")}. A signature covers the hash of one request sent to the model and of the response it gave. The model runs in a trusted execution environment (TEE) that publishes an attestation of its hardware and software.`}
      </p>

      <ul className="grid gap-3">
        {attestations.map((attestation, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: one signer can sign several calls, and two rows can be alike
            key={i}
            data-testid="attestation"
            className="rounded-xl border border-line bg-ink p-4"
          >
            <dl className={FACTS}>
              <dt className={FACT_LABEL}>Signer</dt>
              <dd className="font-mono text-[13px] wrap-anywhere">{attestation.signer_id}</dd>
              <dt className={FACT_LABEL}>Model</dt>
              <dd className="font-mono text-[13px] wrap-anywhere">{attestation.model}</dd>
              <dt className={FACT_LABEL}>Request</dt>
              <dd className="font-mono text-[13px] wrap-anywhere">{attestation.request_hash}</dd>
              <dt className={FACT_LABEL}>Response</dt>
              <dd className="font-mono text-[13px] wrap-anywhere">{attestation.response_hash}</dd>
            </dl>
          </li>
        ))}
      </ul>

      <div className="grid gap-3 rounded-xl border border-line bg-ink p-4 text-sm text-muted">
        <h3 className={FACT_LABEL}>How to check</h3>
        <p>
          {`From a clone of the repository, with Node installed, run this. It hashes the request and response saved in the scorecard, checks ${many ? "each signature" : "the signature"} and that the signer is registered on chain, and prints ATTESTED for ${many ? "each" : "it"}.`}
        </p>
        <p
          data-testid="attested-command"
          className="font-mono text-[13px] text-bone/90 wrap-anywhere"
        >
          {command}
        </p>
        <p data-testid="attested-limits">
          This does not prove the score is correct. The contract checks only that a registered key
          signed these hashes. It cannot check the TEE&rsquo;s attestation itself: the owner did
          that off chain before registering the signer.
        </p>
      </div>
    </section>
  );
}
