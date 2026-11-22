import { createHash } from "node:crypto";

/** Git blob id of some bytes: sha1("blob <size>\0" + bytes). Lets a client know a file's hash without git. */
export function blobHash(bytes: Uint8Array): string {
  const h = createHash("sha1");
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest("hex");
}
