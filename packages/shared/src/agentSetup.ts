import { sha256Hex } from "./hash";

// The code "Connect your agent" deploys on a new agent account (contract/agent-setup), as the bytes
// of contract/res/agent_setup.wasm. The owner's wallet sends them in the transaction that creates
// the account, with the call of `setup` that adds the agent's key from inside it, so that the
// wallet sees no AddKey action. A test holds these bytes to contract/res/agent_setup.wasm and to its
// line in contract/res/SHA256SUMS: after contract/build.sh writes a new build, paste the output of
// `base64 -i contract/res/agent_setup.wasm` here (in lines of 88) and its SHA-256 below.

/** contract/res/agent_setup.wasm, in base64. */
const AGENT_SETUP_WASM_BASE64 = [
  "AGFzbQEAAAABRgxgAX4AYAJ+fgBgAX4BfmAFfn5+fn4BfmACfn4BfmAEfn5+fgBgBH9/f38AYAJ/fwBgAX8Bf2AD",
  "f39/AGADf39/AX9gAAAC3gEJA2VudgpwYW5pY191dGY4AAEDZW52DHJlZ2lzdGVyX2xlbgACA2Vudg1yZWFkX3Jl",
  "Z2lzdGVyAAEDZW52EmN1cnJlbnRfYWNjb3VudF9pZAAAA2VudhZwcmVkZWNlc3Nvcl9hY2NvdW50X2lkAAADZW52",
  "BWlucHV0AAADZW52DXN0b3JhZ2Vfd3JpdGUAAwNlbnYUcHJvbWlzZV9iYXRjaF9jcmVhdGUABANlbnYtcHJvbWlz",
  "ZV9iYXRjaF9hY3Rpb25fYWRkX2tleV93aXRoX2Z1bGxfYWNjZXNzAAUDBwYGBwgJCgsFAwEAEQYZA38BQYCAwAAL",
  "fwBB8oHAAAt/AEGAgsAACwctBAZtZW1vcnkCAAVzZXR1cAAOCl9fZGF0YV9lbmQDAQtfX2hlYXBfYmFzZQMCDAEB",
  "CpoKBiAAIAEgA00EQCAAIAMgAWs2AgQgACABIAJqNgIADwsACwsAIAGtIACtEAAACyYBAX5CABABIgFCwABYBEBC",
  "ACAArRACIAGnDwtB0oDAAEE3EAoAC3UBA38jAEEQayIEJAADQAJAIAIgA0YEQCACIQMMAQsgASADai0AAEEJayIF",
  "QRdLQQEgBXRBk4CABHFFcg0AIANBAWohAwwBCwsgBEEIaiADIAEgAhAJIAQoAgwhASAAIAQoAgg2AgAgACABNgIE",
  "IARBEGokAAtEAQN/AkAgAkUNAANAIAAtAAAiBCABLQAAIgVGBEAgAEEBaiEAIAFBAWohASACQQFrIgINAQwCCwsg",
  "BCAFayEDCyADRQuICAIMfwF+IwBBkANrIgAkACAAQShqIgFBAEHAAPwLACAAQegAaiIEQQBBwAD8CwAgAEGoAWpB",
  "AEGAAfwLAEIAEAMgARALIQlCABAEIAQQCyEBAkACQAJAA0AgAiAJRg0BIABBKGogAmotAABBLkcEQCACQQFqIQIM",
  "AQsLIABBIGogAkEBaiAAQShqIAkQCSAAKAIkIAFHDQAgACgCICAAQegAaiABEA1FDQBCABAFQgAQASIMQoEBVARA",
  "QgAgAEGoAWoiBa0QAiAAQQk2AuwCIABByIDAADYC6AIgAEEBNgLkAiAAQceAwAA2AuACIABBDDYC3AIgAEG7gMAA",
  "NgLYAiAAQQE2AtQCIABBuoDAADYC0AIgDKchCEEAIQEDQCABQQhqIgRBKEcEQCAAQcgCaiABaiIBQQhqKAIAIQYg",
  "AUEMaigCACEDIABBGGogBSAIEAwgACgCHCIBIANJDQUgASADayEIIAAoAhgiCiADaiEFIAQhASAKIAYgAxANDQEM",
  "BQsLA0AgByAIRg0EIAUgB2oiCy0AAEEiRwRAIAdBAWohBwwBCwsgAEIANwPgAiAAQgA3A9gCIABCADcD0AIgAEIA",
  "NwPIAkEAIQMgBSEBQQAhBgNAIAEgC0YEQEEAIQIgB0UCfwNAQSAgAkEgRg0BGiAAQcgCaiACaiACQQFqIgQhAi0A",
  "AEUNAAsgBEEBawsgBkdyDQUgACAAKQPgAjcDiAMgACAAKQPYAjcDgAMgACAAKQPQAjcD+AIgACAAKQPIAjcD8AIg",
  "AEEQaiAHQQFqIAUgCBAJIABBCGogACgCECAAKAIUEAwgACgCDCIBRQ0FIAAoAggiBEHRgMAAQQEQDUUNBSAAIARB",
  "AWogAUEBaxAMIAAoAgQNBSAAIAApA4gDNwPAAiAAIAApA4ADNwO4AiAAIAApA/gCNwOwAiAAIAApA/ACNwOoAkIE",
  "QseBwABCAULLgcAAQgAQBlBFDQQgAEEAOgDIAiAAIAApA6gCNwDJAiAAIAApA7ACNwDRAiAAIAApA7gCNwDZAiAA",
  "IAApA8ACNwDhAiAJrSAAQShqrRAHQiEgAEHIAmqtQgAQCCAAQZADaiQADwsgA0EBaiEEIAFBAWohCkEAIQIgAS0A",
  "ACEBA0AgAkE6Rg0FIAEgAkGAgEBrLQAARwRAIAJBAWohAgwBCwsCQCACIAMgBkdyRQRAIAQhBiADQX9GDQELQR8h",
  "AQNAIAFBf0YEQCAKIQEgBCEDIAJFDQMMBwUgAEHIAmogAWoiAyADLQAAQTpsIAJqIgM6AAAgAUEBayEBIANBCHYh",
  "AgwBCwALAAsLAAtBiYHAAEE+EAoAC0HSgMAAQTcQCgALQcyBwABBJhAKAAtBiYHAAEE+EAoACwv8AQEAQYCAwAAL",
  "8gExMjM0NTY3ODlBQkNERUZHSEpLTE1OUFFSU1RVVldYWVphYmNkZWZnaGlqa21ub3BxcnN0dXZ3eHl6eyJwdWJs",
  "aWNfa2V5IjoiZWQyNTUxOTp9RV9BVVRIOiBvbmx5IHRoZSBwYXJlbnQgYWNjb3VudCBjYW4gc2V0IHRoaXMgYWNj",
  "b3VudCB1cEVfQVJHUzogZXhwZWN0ZWQgeyJwdWJsaWNfa2V5IjoiZWQyNTUxOTo8YmFzZTU4IG9mIDMyIGJ5dGVz",
  "PiJ9ZG9uZTFFX0RPTkU6IHRoaXMgYWNjb3VudCBpcyBzZXQgdXAgYWxyZWFkeQ==",
].join("");

/** The SHA-256 of the bytes, as contract/res/SHA256SUMS has it. */
export const AGENT_SETUP_WASM_SHA256 =
  "3164f804e4ebce98cd89e7cbdebf8d6c624011f576f86de64a7f72df623a2781";

/** How many bytes the code is: what every agent account made with it stores (0.01 NEAR per KB). */
export const AGENT_SETUP_WASM_BYTES = 1960;

/**
 * The bytes of the setup code, for a DeployContract action. Each call gives a new copy, checked
 * against `AGENT_SETUP_WASM_SHA256`: a copy that is not the build in contract/res is never sent.
 */
export function agentSetupWasm(): Uint8Array {
  const text = atob(AGENT_SETUP_WASM_BASE64);
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  if (bytes.length !== AGENT_SETUP_WASM_BYTES || sha256Hex(bytes) !== AGENT_SETUP_WASM_SHA256) {
    throw new Error("the agent setup code is not the build in contract/res/agent_setup.wasm");
  }
  return bytes;
}
