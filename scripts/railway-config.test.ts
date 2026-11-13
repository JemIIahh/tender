import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./lib/env";

// `railway.json` is Railway's config as code for the services (docs/RUNBOOK.md, "Hosting on
// Railway"), and `railway.agents.json` the one for the reference agents, a second service from the
// same repository ("Hosting the agents on Railway"). Nothing here runs Railway: it holds the files
// to what the runbook says of them.

interface RailwayConfig {
  build: { builder: string; dockerfilePath: string };
  deploy: {
    startCommand?: string;
    healthcheckPath: string;
    healthcheckTimeout: number;
    restartPolicyType: string;
    restartPolicyMaxRetries: number;
    numReplicas: number;
    drainingSeconds: number;
  };
}

const read = (path: string) => readFile(join(REPO_ROOT, path), "utf8");

test("railway_config_builds_the_dockerfile_and_runs_one_services_process", async () => {
  const config = JSON.parse(await read("railway.json")) as RailwayConfig;

  // The Dockerfile is the one build, and its command is the one command: `pnpm serve`.
  expect(config.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });
  expect(config.deploy.startCommand).toBeUndefined();
  expect(await read(config.build.dockerfilePath)).toMatch(/^CMD \["pnpm", "serve"\]$/m);

  // One services process per database: a second replica would only wait for the indexer lock.
  expect(config.deploy.numReplicas).toBe(1);

  // The check is the route `GET /v1/health`, which answers 200 while the indexer catches up, and
  // it has the 300 s the runbook names.
  expect(config.deploy.healthcheckPath).toBe("/v1/health");
  expect(config.deploy.healthcheckTimeout).toBe(300);

  // The old container, on a redeploy, has 30 s between SIGTERM and SIGKILL to finish a call.
  expect(config.deploy.drainingSeconds).toBe(30);

  // A crash is retried a few times, and not for ever: the services end with 1 when the database is
  // another deploy's, and a restart cannot fix that.
  expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
  expect(config.deploy.restartPolicyMaxRetries).toBe(3);
});

test("railway_agents_config_builds_the_same_dockerfile_and_runs_the_agents_supervisor", async () => {
  const services = JSON.parse(await read("railway.json")) as { $schema: string };
  const config = JSON.parse(await read("railway.agents.json")) as {
    $schema: string;
    build: RailwayConfig["build"];
    deploy: Partial<RailwayConfig["deploy"]>;
  };

  // The same schema and the same image as the services: only the command differs.
  expect(config.$schema).toBe(services.$schema);
  expect(config.build).toEqual({ builder: "DOCKERFILE", dockerfilePath: "Dockerfile" });

  // The supervisor, run by node itself with no shell in front of it, so that Railway's SIGTERM
  // reaches it and it passes it on to the agents. The script is in the repository, and so in the
  // image.
  expect(config.deploy.startCommand).toBe("node scripts/run-agents.mjs");
  expect(await read("scripts/run-agents.mjs")).toMatch(/^#!\/usr\/bin\/env node\n/);

  // The agents serve no HTTP, so there is nothing for a healthcheck to ask.
  expect(config.deploy.healthcheckPath).toBeUndefined();
  expect(config.deploy.healthcheckTimeout).toBeUndefined();

  // One replica: each agent's key signs in one process only, and Railway takes no replicas on a
  // service with a volume.
  expect(config.deploy.numReplicas).toBe(1);

  // An agent that ends makes the supervisor end with 1, and Railway restarts the service a few
  // times, not for ever: an agent that cannot start (a missing variable) fails each time.
  expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
  expect(config.deploy.restartPolicyMaxRetries).toBe(3);

  // The supervisor gives each agent 10 s from SIGTERM to SIGKILL, inside Railway's 30 s.
  expect(config.deploy.drainingSeconds).toBe(30);
});
