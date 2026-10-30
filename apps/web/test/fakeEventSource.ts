import { TenderEventSchema } from "@tender/shared";

/**
 * A stand-in for the browser's `EventSource`, which jsdom does not have. Tests install it with
 * `vi.stubGlobal("EventSource", FakeEventSource)` and drive the stream by hand through the methods
 * below: what the server sends, and how the browser reports a connection that is gone.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every stream opened since the last `reset`, oldest first. */
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The stream most recently opened. */
  static get latest(): FakeEventSource {
    const stream = FakeEventSource.instances.at(-1);
    if (!stream) throw new Error("no EventSource has been opened");
    return stream;
  }

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  private lastEventId = "";

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The names this stream has a listener for. */
  get listening(): string[] {
    return [...this.listeners.entries()].filter(([, set]) => set.size > 0).map(([name]) => name);
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  // ---- What the server and the browser do -----------------------------------------------------

  /** The response arrived: the stream is open. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatch("open", new Event("open"));
  }

  /**
   * A named message with `data` as the server writes it. `id` is the `id:` line; a message without
   * one leaves the stream's last id where it was, as in a browser.
   */
  send(name: string, data: unknown, id?: string): void {
    if (id !== undefined) this.lastEventId = id;
    const event = Object.assign(new Event(name), {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId: this.lastEventId,
    });
    this.dispatch(name, event);
  }

  /** The browser lost the connection and will try again by itself. */
  dropAndRetry(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatch("error", new Event("error"));
  }

  /** The server answered with a status the browser gives up on: the stream is closed for good. */
  failForGood(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatch("error", new Event("error"));
  }
}

/** Every event name of the contract, as the stream names its messages. */
export const EVENT_NAMES: string[] = TenderEventSchema.options.map(
  (option) => option.shape.event.value,
);

/** The message the API sends for an event about `taskId`. */
export function message(event: string, taskId: string | null, data: Record<string, unknown> = {}) {
  return { event, data, height: "1000", task_id: taskId };
}

/** A `committed` event's data, which fits `TenderEventSchema`. */
export function committedData(taskId: string, account = "alice.testnet"): Record<string, unknown> {
  return {
    task_id: taskId,
    account,
    commitment: "a".repeat(64),
    replaced: false,
    block_height: "1000",
  };
}
