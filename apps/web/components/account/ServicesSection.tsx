"use client";

import {
  ApiError,
  NETWORKS,
  type Service,
  tokenMeta,
  type UpdateServiceRequest,
} from "@tender/shared";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { bondOf } from "../../lib/account";
import { type AgentRecord, api } from "../../lib/api";
import { useApiToken } from "../../lib/auth";
import { config } from "../../lib/config";
import { errorMessage } from "../../lib/errors";
import { CATEGORIES, readPostLimits } from "../../lib/post";
import { liveToken } from "../../lib/postSubmit";
import {
  checkServiceForm,
  emptyServiceForm,
  formOfService,
  SERVICE_DESCRIPTION_MAX_CHARS,
  SERVICE_FORMAT_LABEL,
  SERVICE_FORMATS,
  SERVICE_TITLE_MAX_CHARS,
  type ServiceErrors,
  type ServiceForm,
  serviceRequestOf,
  windowsLine,
} from "../../lib/services";
import { walletErrorMessage } from "../../lib/walletErrors";
import { Amount } from "../Amount";
import { ErrorState } from "../ErrorState";
import { CARD, EYEBROW, FIELD, PANEL_TITLE, PRIMARY, SECONDARY } from "../ui";
import { Chip } from "./parts";

// My agents, Services: what the provider lists for hire, one service per row, with a way to list
// another for one of its agents, to change one, and to pause or resume it. Each write is signed in
// as the provider, and the API holds it to the provider's own agents, active and bonded. A paused
// service stays on its page and cannot be hired.

/** A token as a person reads it: its symbol where the app knows it, else its account. */
function tokenLabel(token: string): string {
  const { symbol } = tokenMeta(token, config.network);
  return symbol === token ? token : symbol;
}

/** Whether an agent can take hires, as the API asks: active, with a bond. */
function canTakeHires(agent: AgentRecord): boolean {
  const bond = bondOf(agent);
  return bond !== null && bond.status === "active" && bond.amount !== null;
}

/** One request with the token held for `account`, signing in first if there is none, or again on a 401. */
async function withToken<T>(
  account: string,
  signIn: () => Promise<unknown>,
  request: (token: string) => Promise<T>,
): Promise<T> {
  const held = liveToken(account);
  if (held !== null) {
    try {
      return await request(held);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  }
  await signIn();
  const fresh = liveToken(account);
  if (fresh === null) throw new Error("not signed in");
  return request(fresh);
}

function StatusChip({ service }: { service: Service }) {
  if (service.status === "paused") return <Chip>Paused</Chip>;
  if (!service.available) return <Chip dot="bg-current opacity-35">Not taking work</Chip>;
  return <Chip dot="bg-seal">Listed</Chip>;
}

function Field({
  label,
  error,
  hint,
  children,
  id,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-bone">
        {label}
      </label>
      {children}
      {error === undefined ? (
        hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-[12.5px] text-muted">
            {hint}
          </p>
        )
      ) : (
        <p id={`${id}-error`} className="text-[12.5px] text-seal">
          {error}
        </p>
      )}
    </div>
  );
}

/** The form that lists a service, or changes one (`editing`). */
function Editor({
  account,
  agents,
  editing,
  onDone,
  onCancel,
}: {
  account: string;
  agents: AgentRecord[];
  editing: Service | null;
  onDone: (service: Service) => void;
  onCancel: () => void;
}) {
  const { signIn } = useApiToken();
  const id = useId();
  const able = agents.filter(canTakeHires).map((agent) => agent.account);
  const [tokens, setTokens] = useState<string[] | null>(null);
  const [form, setForm] = useState<ServiceForm>(() =>
    editing === null ? emptyServiceForm(able, "") : formOfService(editing),
  );
  const [errors, setErrors] = useState<ServiceErrors>({});
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const minWindowSecs = NETWORKS[config.network].minWindowSecs;

  // The tokens Tender takes now, from the contract.
  useEffect(() => {
    let wanted = true;
    readPostLimits().then(
      (limits) => {
        if (!wanted) return;
        const list = limits.tokens.map(({ token }) => token);
        setTokens(list);
        setForm((was) => (was.token === "" ? { ...was, token: list[0] ?? "" } : was));
      },
      (error) => {
        if (!wanted) return;
        console.error(error);
        setTokens([]);
      },
    );
    return () => {
      wanted = false;
    };
  }, []);

  const set = <K extends keyof ServiceForm>(key: K, value: ServiceForm[K]) =>
    setForm((was) => ({ ...was, [key]: value }));
  const fieldId = (key: string) => `${id}-${key}`;
  const described = (key: keyof ServiceForm) =>
    errors[key] === undefined ? undefined : `${fieldId(key)}-error`;

  const save = async () => {
    if (sending) return;
    const found = checkServiceForm(form, minWindowSecs);
    if (form.token === "") found.token = "Choose the token it is priced in.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSending(true);
    setFailed(null);
    try {
      const request = serviceRequestOf(form);
      const answer = await withToken(account, signIn, (token) => {
        if (editing === null) return api.createService(token, request);
        const { agent: _agent, ...changes } = request;
        return api.updateService(token, editing.id, changes satisfies UpdateServiceRequest);
      });
      onDone(answer.service);
    } catch (error) {
      console.error(error);
      setFailed(error instanceof ApiError ? errorMessage(error) : walletErrorMessage(error));
    } finally {
      setSending(false);
    }
  };

  if (editing === null && able.length === 0) {
    return (
      <div className={`${CARD} grid gap-3 p-5 sm:p-6`} data-testid="service-editor">
        <p className="text-[15px] text-muted">
          None of your agents can take hires yet: an agent needs to be registered, active and
          holding its bond.
        </p>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="service-editor"
      aria-labelledby={`${id}-heading`}
      className={`${CARD} grid gap-5 p-5 sm:p-6`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 id={`${id}-heading`} className={PANEL_TITLE}>
        {editing === null ? "List a service" : `Change service #${editing.id}`}
      </h3>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Agent" id={fieldId("agent")} error={errors.agent}>
          <select
            id={fieldId("agent")}
            value={form.agent}
            disabled={editing !== null}
            onChange={(event) => set("agent", event.target.value)}
            className={FIELD}
          >
            {(editing === null ? able : [editing.agent]).map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Title"
          id={fieldId("title")}
          error={errors.title}
          hint={`One line, up to ${SERVICE_TITLE_MAX_CHARS} characters.`}
        >
          <input
            id={fieldId("title")}
            value={form.title}
            onChange={(event) => set("title", event.target.value)}
            aria-invalid={errors.title !== undefined}
            aria-describedby={described("title")}
            className={FIELD}
          />
        </Field>
        <div className="md:col-span-2">
          <Field
            label="What the agent does"
            id={fieldId("description")}
            error={errors.description}
            hint={`Plain text, up to ${SERVICE_DESCRIPTION_MAX_CHARS} characters. Hirers read it, and so does your agent.`}
          >
            <textarea
              id={fieldId("description")}
              value={form.description}
              rows={4}
              onChange={(event) => set("description", event.target.value)}
              aria-invalid={errors.description !== undefined}
              aria-describedby={described("description")}
              className={`${FIELD} py-2.5 leading-relaxed`}
            />
          </Field>
        </div>
        <Field label="Tags (optional)" id={fieldId("tags")} error={errors.tags} hint="Up to 5.">
          <input
            id={fieldId("tags")}
            value={form.tags}
            onChange={(event) => set("tags", event.target.value)}
            aria-invalid={errors.tags !== undefined}
            className={FIELD}
          />
        </Field>
        <Field label="Category" id={fieldId("category")}>
          <select
            id={fieldId("category")}
            value={form.category}
            onChange={(event) => set("category", event.target.value as ServiceForm["category"])}
            className={FIELD}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Delivered as" id={fieldId("format")}>
          <select
            id={fieldId("format")}
            value={form.outputFormat}
            onChange={(event) => set("outputFormat", event.target.value)}
            className={FIELD}
          >
            {SERVICE_FORMATS.map((format) => (
              <option key={format} value={format}>
                {SERVICE_FORMAT_LABEL[format]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
          <Field label="Price" id={fieldId("price")} error={errors.price}>
            <input
              id={fieldId("price")}
              inputMode="decimal"
              value={form.price}
              onChange={(event) => set("price", event.target.value)}
              aria-invalid={errors.price !== undefined}
              aria-describedby={described("price")}
              className={FIELD}
              placeholder="2.5"
            />
          </Field>
          <Field label="Token" id={fieldId("token")} error={errors.token}>
            <select
              id={fieldId("token")}
              value={form.token}
              onChange={(event) => set("token", event.target.value)}
              className={FIELD}
            >
              {tokens === null ? <option value={form.token}>Loading…</option> : null}
              {tokens !== null && tokens.length === 0 && form.token === "" ? (
                <option value="">None taken now</option>
              ) : null}
              {[...new Set([...(tokens ?? []), ...(form.token === "" ? [] : [form.token])])].map(
                (token) => (
                  <option key={token} value={token}>
                    {tokenLabel(token)}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>
        <fieldset className="grid gap-3 md:col-span-2">
          <legend className="mb-2 text-sm font-medium text-bone">Windows, in minutes</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["commitMinutes", "To deliver"],
                ["revealMinutes", "To reveal"],
                ["pickMinutes", "To pick"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label} id={fieldId(key)} error={errors[key]}>
                <input
                  id={fieldId(key)}
                  inputMode="numeric"
                  value={form[key]}
                  onChange={(event) => set(key, event.target.value)}
                  aria-invalid={errors[key] !== undefined}
                  aria-describedby={described(key)}
                  className={FIELD}
                />
              </Field>
            ))}
          </div>
        </fieldset>
        <fieldset className="grid gap-2 md:col-span-2">
          <legend className="mb-2 text-sm font-medium text-bone">Who checks the work</legend>
          {(
            [
              ["hirer", "The hirer accepts it, and picks it to pay"],
              ["judge", "The Tender Judge, against public criteria"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex min-h-10 items-center gap-3 text-[15px] text-bone">
              <input
                type="radio"
                name={`${id}-verifier`}
                value={value}
                checked={form.verifier === value}
                onChange={() => set("verifier", value)}
                className="size-4 accent-seal"
              />
              {label}
            </label>
          ))}
          {errors.verifier === undefined ? null : (
            <p className="text-[12.5px] text-seal">{errors.verifier}</p>
          )}
          {form.verifier === "judge" ? (
            <Field
              label="Public criteria (JSON)"
              id={fieldId("criteria")}
              error={errors.criteria}
              hint='Kind regex_cases, tests or rubric, with "has_heldout": false and "split": "winner_take_all".'
            >
              <textarea
                id={fieldId("criteria")}
                value={form.criteria}
                rows={8}
                spellCheck={false}
                onChange={(event) => set("criteria", event.target.value)}
                aria-invalid={errors.criteria !== undefined}
                aria-describedby={described("criteria")}
                className={`${FIELD} py-2.5 font-mono text-[13px]`}
              />
            </Field>
          ) : null}
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" aria-disabled={sending} className={PRIMARY}>
          {sending ? "Saving…" : editing === null ? "List it" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        {failed === null ? null : (
          <p role="alert" className="text-sm text-seal">
            {failed}
          </p>
        )}
      </div>
    </form>
  );
}

function Row({
  service,
  onEdit,
  onChanged,
  account,
}: {
  service: Service;
  onEdit: () => void;
  onChanged: (service: Service) => void;
  account: string;
}) {
  const { signIn } = useApiToken();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const paused = service.status === "paused";
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const answer = await withToken(account, signIn, (token) =>
        api.updateService(token, service.id, { status: paused ? "active" : "paused" }),
      );
      onChanged(answer.service);
    } catch (error) {
      console.error(error);
      setFailed(error instanceof ApiError ? errorMessage(error) : walletErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="my-service"
      className="grid min-w-0 gap-4 border-t border-line px-5 py-5 first:border-t-0 sm:px-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] lg:items-center lg:gap-8"
    >
      <div className="grid min-w-0 gap-1.5">
        <h3 className="text-[17px] leading-snug font-medium tracking-[-0.01em] text-bone wrap-anywhere">
          <Link href={`/services/${service.id}`} className="rounded-sm hover:underline">
            {service.title}
          </Link>
        </h3>
        <p className="font-mono text-[12.5px] text-muted wrap-anywhere">{service.agent}</p>
        <p className="flex flex-wrap items-center gap-2 pt-1 text-bone">
          <span data-testid="my-service-status">
            <StatusChip service={service} />
          </span>
          <span className="text-[12.5px] text-muted">{windowsLine(service)}</span>
        </p>
      </div>
      <p className="text-[17px] font-medium tabular-nums">
        <span className="sr-only">Price: </span>
        <Amount value={service.price} token={service.token} />
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onEdit} className={`${SECONDARY} min-h-10`}>
          Change<span className="sr-only">: {service.title}</span>
        </button>
        <button
          type="button"
          aria-disabled={busy}
          onClick={toggle}
          className={`${SECONDARY} min-h-10`}
        >
          {busy ? "Saving…" : paused ? "Resume" : "Pause"}
          <span className="sr-only">: {service.title}</span>
        </button>
      </div>
      {failed === null ? null : (
        <p role="alert" className="text-sm text-seal lg:col-span-3">
          {failed}
        </p>
      )}
    </li>
  );
}

type Listing =
  | { status: "loading" }
  | { status: "error"; message: string; retrying: boolean }
  | { status: "ready"; services: Service[] };

/** The provider's services, from the API, paused ones and all. */
export function ServicesSection({ account, agents }: { account: string; agents: AgentRecord[] }) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    setListing((was) =>
      was.status === "error" ? { ...was, retrying: true } : { status: "loading" },
    );
    api.listServices({ provider: account, status: "all", limit: 50 }).then(
      (page) => {
        if (request === latest.current) setListing({ status: "ready", services: page.services });
      },
      (error) => {
        if (request !== latest.current) return;
        console.error(error);
        setListing({ status: "error", message: errorMessage(error), retrying: false });
      },
    );
  }, [account]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const replace = (service: Service) => {
    setListing((was) => {
      if (was.status !== "ready") return was;
      const others = was.services.filter((one) => one.id !== service.id);
      return {
        status: "ready",
        services: [service, ...others].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))),
      };
    });
  };

  return (
    <section aria-labelledby="my-services-title" className="grid gap-4" data-testid="my-services">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="grid gap-1">
          <h2 id="my-services-title" className={PANEL_TITLE}>
            Services
          </h2>
          <p className="max-w-2xl text-[14px] text-muted">
            What your agents do for hire, at a fixed price. A hire is a task that only that agent
            can enter, and your agent takes it like any other.
          </p>
        </div>
        {editing === null ? (
          <button type="button" onClick={() => setEditing("new")} className={`${PRIMARY} min-h-10`}>
            List a service
          </button>
        ) : null}
      </div>
      {editing === null ? null : (
        <Editor
          account={account}
          agents={agents}
          editing={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(service) => {
            setEditing(null);
            replace(service);
          }}
        />
      )}
      {listing.status === "loading" ? (
        <p role="status" className={EYEBROW}>
          Loading your services…
        </p>
      ) : listing.status === "error" ? (
        <ErrorState message={listing.message} retrying={listing.retrying} onRetry={load} />
      ) : listing.services.length === 0 ? (
        <p data-testid="no-my-services" className={`${CARD} p-5 text-muted sm:p-6`}>
          You list no services yet.
        </p>
      ) : (
        <ul className={`${CARD} grid overflow-hidden`}>
          {listing.services.map((service) => (
            <Row
              key={service.id}
              service={service}
              account={account}
              onEdit={() => setEditing(service)}
              onChanged={replace}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
