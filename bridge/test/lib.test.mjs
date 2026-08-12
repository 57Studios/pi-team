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
  loadLidMap,
  resolveSender,
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

await t("rememberSender / lastSender round-trip (digits and full jids)", async () => {
  const bridgeDir = path.join(root, "bridge2");
  await rememberSender(bridgeDir, "+15551234567");
  assert.equal(await lastSender(bridgeDir), "15551234567");
  await rememberSender(bridgeDir, "11111111111@lid");
  assert.equal(await lastSender(bridgeDir), "11111111111@lid");
  await rememberSender(bridgeDir, "+15551234567:10@s.whatsapp.net");
  assert.equal(await lastSender(bridgeDir), "15551234567@s.whatsapp.net");
  assert.equal(await lastSender(path.join(root, "nope")), null);
});

await t("loadLidMap builds both directions from auth dir files", async () => {
  const auth = path.join(root, "auth");
  fs.mkdirSync(auth, { recursive: true });
  fs.writeFileSync(path.join(auth, "lid-mapping-15551234567.json"), JSON.stringify("11111111111"));
  fs.writeFileSync(path.join(auth, "lid-mapping-11111111111_reverse.json"), JSON.stringify("15551234567"));
  const map = await loadLidMap(auth);
  assert.equal(map.lidToPhone["11111111111"], "15551234567");
  assert.equal(map.phoneToLid["15551234567"], "11111111111");
  assert.equal((await loadLidMap(path.join(root, "noauth"))).lidToPhone["1"], undefined); // no auth: empty map, no throw
});

await t("resolveSender maps @lid jids to the phone via the lid map", async () => {
  const map = { lidToPhone: { "11111111111": "15551234567" }, phoneToLid: {} };
  const lid = resolveSender("11111111111@lid", map);
  assert.equal(lid.phone, "15551234567");
  assert.equal(lid.isLid, true);
  assert.equal(lid.jid, "11111111111@lid");
  const classic = resolveSender("15551234567@s.whatsapp.net", map);
  assert.equal(classic.phone, "15551234567");
  assert.equal(classic.isLid, false);
  const withDev = resolveSender("15551234567:10@s.whatsapp.net", map);
  assert.equal(withDev.jid, "15551234567@s.whatsapp.net");
  const unknown = resolveSender("99999999999@lid", map); // not in map
  assert.equal(unknown.phone, null);
});

await t("owner allowlist accepts a LID-resolved phone and rejects others", async () => {
  const owners = ["15551234567"];
  const map = { lidToPhone: { "11111111111": "15551234567" }, phoneToLid: {} };
  const owner = resolveSender("11111111111@lid", map);
  assert.equal(isAllowed(owner.phone, owners), true);
  const stranger = resolveSender("99999999999@lid", map);
  assert.equal(isAllowed(stranger.phone, owners), false);
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
