import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeNumber,
  isAllowed,
  buildInboundEnvelope,
  deliverInbound,
  enqueueReply,
  drainOutbox,
  rememberSender,
  lastSender,
  loadConfig,
} from "../lib.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-test-"));
let passed = 0;

async function t(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error("FAILED:", name, "\n ", e.message);
    process.exitCode = 1;
  }
}

await t("normalizeNumber strips +, spaces, leading 00", () => {
  assert.equal(normalizeNumber("+1 (555) 123-4567"), "15551234567");
  assert.equal(normalizeNumber("00915551234567"), "915551234567");
  assert.equal(normalizeNumber(""), null);
});

await t("isAllowed fails closed (no owners = nobody)", () => {
  assert.equal(isAllowed("15551234567", []), false);
  assert.equal(isAllowed("15551234567", ["15551234567", "14155559876"]), true);
  assert.equal(isAllowed("19999999999", ["15551234567"]), false);
});

await t("buildInboundEnvelope shape (wake true, type wa)", () => {
  const e = buildInboundEnvelope({ from: "+15551234567", fromName: "You", body: "status?" });
  assert.equal(e.type, "wa");
  assert.equal(e.wake, true);
  assert.equal(e.from, "wa:15551234567");
  assert.equal(e.body, "status?");
  assert.ok(e.id.startsWith("wa_"));
});

await t("deliverInbound writes into the member inbox (readable by the bus)", async () => {
  const teamsRoot = path.join(root, "teams");
  const e = buildInboundEnvelope({ from: "+15551234567", body: "hello" });
  const id = await deliverInbound(teamsRoot, "Dispatch", "dispatcher-main", e);
  const file = path.join(teamsRoot, "Dispatch", "inbox", "dispatcher-main", `${id}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.body, "hello");
  assert.equal(parsed.wake, true);
});

await t("outbox queue round-trip (enqueue -> drain in order, acked)", async () => {
  const bridgeDir = path.join(root, "bridge");
  await enqueueReply(bridgeDir, { to: "15551234567", body: "first" });
  await enqueueReply(bridgeDir, { to: "15551234567", body: "second" });
  const drained = await drainOutbox(bridgeDir);
  assert.equal(drained.length, 2);
  assert.equal(drained[0].body, "first");
  assert.equal(drained[1].body, "second");
  assert.equal((await drainOutbox(bridgeDir)).length, 0); // acked
});

await t("rememberSender / lastSender round-trip", async () => {
  const bridgeDir = path.join(root, "bridge2");
  await rememberSender(bridgeDir, "+15551234567");
  assert.equal(await lastSender(bridgeDir), "15551234567");
  assert.equal(await lastSender(path.join(root, "nope")), null);
});

await t("loadConfig defaults are OUTSIDE the repo", () => {
  const cfg = loadConfig({ HOME: "/tmp/home", WA_OWNERS: "+15551234567" });
  assert.ok(cfg.bridgeDir.startsWith("/tmp/home/.pi/wa-bridge"));
  assert.equal(cfg.team, "Dispatch");
  assert.equal(cfg.memberId, "dispatcher-main");
  assert.deepEqual(cfg.owners, ["15551234567"]);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`bridge lib tests: ${passed} passed` + (process.exitCode ? " (with failures)" : ""));
