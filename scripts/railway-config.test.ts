import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO_ROOT } from "./lib/env";

// `railway.json` is Railway's config as code for the services (docs/RUNBOOK.md, "Hosting on
// Railway"). Nothing here runs Railway: it holds the file to what the runbook says of it.

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
