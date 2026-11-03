import type { Locator, Page } from "@playwright/test";

/**
 * The board's card for the task titled exactly `title`. It is found by its heading, matched whole
 * and with its case, and not by a piece of its text: a task whose title held another's would
 * otherwise make two cards, and a locator that must be one fails on two.
 */
export function cardTitled(page: Page, title: string): Locator {
  return page
    .getByTestId("task-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
