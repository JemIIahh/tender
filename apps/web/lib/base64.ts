/** How many bytes `toBase64` turns into characters at a time. */
const SLICE = 0x8000;

/** `bytes` as standard base64 with padding, which is what the API and the RPC read. */
export function toBase64(bytes: Uint8Array): string {
  // `btoa` takes a string with one character per byte. A big array is turned into one a slice at
  // a time, since spreading all of it into a call's arguments overflows the stack.
  let binary = "";
  for (let start = 0; start < bytes.length; start += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + SLICE));
  }
  return btoa(binary);
}
