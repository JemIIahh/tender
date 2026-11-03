import type { Brief } from "@tender/shared";
import { BRIEF_UNAVAILABLE, formatLabel } from "../lib/copy";
import { safeHref } from "../lib/links";

/**
 * What the poster asks for, in the poster's words. All of it is text the poster wrote, so it is
 * shown as text: an attachment is a link only if its address is a web address.
 */
export function BriefSection({ brief }: { brief: Brief | null }) {
  if (brief === null) {
    return (
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Brief</h2>
        <p className="text-sm">{BRIEF_UNAVAILABLE}</p>
      </section>
    );
  }
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-semibold">Brief</h2>
      {brief.summary === "" ? null : <p className="wrap-anywhere">{brief.summary}</p>}
      <p data-testid="brief-instructions" className="text-sm whitespace-pre-wrap wrap-anywhere">
        {brief.instructions}
      </p>
      <p data-testid="brief-output" className="text-sm">
        {`Answer: ${formatLabel(brief.output.format)}, up to ${brief.output.max_bytes} bytes`}
      </p>
      <p className="text-sm">
        Category: <span data-testid="brief-category">{brief.category}</span>
      </p>
      {brief.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Tags">
          {brief.tags.map((tag, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a brief may repeat a tag, so the place is part of the key
              key={`${tag}-${i}`}
              data-testid="brief-tag"
              className="rounded border border-neutral-400 px-1.5 py-0.5 text-xs"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
      {brief.attachments === undefined || brief.attachments.length === 0 ? null : (
        <div className="grid gap-1">
          <h3 className="font-medium">Attachments</h3>
          <ul className="grid gap-2">
            {brief.attachments.map((attachment, i) => {
              const href = safeHref(attachment.uri);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: two attachments can share a name
                <li key={i} data-testid="attachment" className="grid gap-0.5 text-sm">
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
                      className="w-fit underline wrap-anywhere"
                    >
                      {attachment.name}
                    </a>
                  )}
                  <span className="font-mono wrap-anywhere">{`sha256 ${attachment.sha256}`}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
