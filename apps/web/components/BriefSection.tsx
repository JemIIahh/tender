import type { Brief } from "@tender/shared";
import { BRIEF_UNAVAILABLE, formatLabel } from "../lib/copy";
import { safeHref } from "../lib/links";
import { FACT_LABEL, PANEL, PANEL_TITLE, TAG, TEXT_LINK } from "./ui";

/**
 * What the poster asks for, in the poster's words. All of it is text the poster wrote, so it is
 * shown as text: an attachment is a link only if its address is a web address.
 */
export function BriefSection({ brief }: { brief: Brief | null }) {
  if (brief === null) {
    return (
      <section className={PANEL}>
        <h2 className={PANEL_TITLE}>Brief</h2>
        <p className="text-sm text-muted">{BRIEF_UNAVAILABLE}</p>
      </section>
    );
  }
  return (
    <section className={PANEL}>
      <h2 className={PANEL_TITLE}>Brief</h2>
      {brief.summary === "" ? null : (
        <p className="text-[17px] leading-relaxed text-bone wrap-anywhere">{brief.summary}</p>
      )}
      <p
        data-testid="brief-instructions"
        className="rounded-xl border border-line bg-ink p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-bone/90 wrap-anywhere"
      >
        {brief.instructions}
      </p>
      <div className="grid gap-1 text-sm text-muted">
        <p data-testid="brief-output">
          {`Answer: ${formatLabel(brief.output.format)}, up to ${brief.output.max_bytes} bytes`}
        </p>
      </div>
      {brief.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5 text-bone/85" aria-label="Tags">
          {brief.tags.map((tag, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a brief may repeat a tag, so the place is part of the key
              key={`${tag}-${i}`}
              data-testid="brief-tag"
              className={TAG}
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
      {brief.attachments === undefined || brief.attachments.length === 0 ? null : (
        <div className="grid gap-2">
          <h3 className={FACT_LABEL}>Attachments</h3>
          <ul className="grid gap-2">
            {brief.attachments.map((attachment, i) => {
              const href = safeHref(attachment.uri);
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: two attachments can share a name
                  key={i}
                  data-testid="attachment"
                  className="grid gap-0.5 rounded-xl border border-line bg-ink p-3 text-sm"
                >
                  {href === undefined ? (
                    <>
                      <span className="wrap-anywhere">{attachment.name}</span>
                      <span className="wrap-anywhere">{attachment.uri}</span>
                    </>
                  ) : (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className={`${TEXT_LINK} w-fit wrap-anywhere`}
                    >
                      {attachment.name}
                    </a>
                  )}
                  <span className="font-mono text-xs text-muted wrap-anywhere">{`sha256 ${attachment.sha256}`}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
