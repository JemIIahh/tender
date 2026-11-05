import "./lib/node-check";
import { ensureSandboxNode } from "@tender/client";

// Prints the path of nearcore's sandbox node, downloading it first if this install has none and
// `NEAR_SANDBOX_BIN_PATH` is unset. CI runs it to fill and read a cache of the node (set
// `DIR_TO_DOWNLOAD_BINARY` to the cached directory), so that the jobs do not each download 35 MB
// at their first local chain. On success the path is the only line it prints.
console.log(await ensureSandboxNode());
