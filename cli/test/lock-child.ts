// A process that takes a synced folder's lock, notes when it is inside, and gives it back: lock tests start several at
// once to check that two are never inside together.
import { appendFileSync } from "node:fs";
import { acquireLock, LockedError } from "../src/sync/watch.ts";

const [root, log, hold] = process.argv.slice(2);
try {
  const release = await acquireLock(root!, "lock test");
  appendFileSync(log!, `in ${process.pid}\n`);
  await Bun.sleep(Number(hold ?? 100));
  appendFileSync(log!, `out ${process.pid}\n`);
  await release();
} catch (e) {
  if (!(e instanceof LockedError)) throw e;
  appendFileSync(log!, `refused ${process.pid}\n`);
}
