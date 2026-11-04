import type { RefCallback } from "react";

/**
 * For a row that can scroll sideways (a row of tabs or filters, a long figure): it says on the
 * element whether there is more of it past its right edge (`data-more="true"`), and keeps saying
 * so as it scrolls and as its box or its content changes size. `SCROLL_CUE` (components/ui.ts)
 * fades the edge out while there is, so what is past it shows as more to come, and a row that fits,
 * or is scrolled to its end, shows all of itself. The attribute is the element's own, set here and
 * never by React, so a render does not undo it.
 */
export const scrollCue: RefCallback<HTMLElement> = (element) => {
  if (element === null) return;
  const update = () => {
    const more = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    if (element.dataset.more !== String(more)) element.dataset.more = String(more);
  };
  update();
  element.addEventListener("scroll", update, { passive: true });
  const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  resized?.observe(element);
  for (const child of element.children) resized?.observe(child);
  return () => {
    element.removeEventListener("scroll", update);
    resized?.disconnect();
  };
};
