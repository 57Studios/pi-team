// Unit tests for the pi-team bus. Run: node test/bus.test.mjs
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as bus from "../bus.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-bus-test-"));
let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS ${name}`);
};

const t = async (name, fn) => {
  await fn();
  console.log(`  ✓ ${name}`);
};

const main = async () => {
  await t("create team + members", async () => {
    const res = await bus.createTeam(root, "acme", { name: "Alice" });
    ok("createTeam ok", res.ok);
    ok("team exists", await bus.teamExists(root, "acme"));
    const bad = await bus.createTeam(root, "../evil", {});
    ok("invalid team name rejected", !bad.ok);
    const j1 = await bus.joinMember(root, "acme", { id: "sessA", name: "Alice", role: "coordinator" });
    const j2 = await bus.joinMember(root, "acme", { id: "sessB", name: "Bob", role: "implementer" });
    ok("join A", j1.ok && j1.member.role === "coordinator");
    ok("join B", j2.ok && j2.member.role === "implementer");
    const dup = await bus.joinMember(root, "acme", { id: "sessC", name: "Alice", role: "x" });
    ok("duplicate name rejected", !dup.ok);
    const members = await bus.loadMembers(root, "acme");
    ok("two members stored", Object.keys(members).length === 2);
  });

  await t("resolve targets by name and role", async () => {
    const members = await bus.loadMembers(root, "acme");
    const byRole = bus.resolveTargets(members, "sessA", "role:implementer");
    ok("role:implementer -> Bob", byRole.ids.length === 1 && byRole.ids[0] === "sessB");
    const byName = bus.resolveTargets(members, "sessB", "Alice");
    ok("by name -> Alice", byName.ids.length === 1 && byName.ids[0] === "sessA");
    const self = bus.resolveTargets(members, "sessA", "Alice");
    ok("cannot message self", self.error);
    const missing = bus.resolveTargets(members, "sessA", "Nobody");
    ok("unknown member errors with roster hint", missing.error && missing.error.includes("Roster"));
  });

  await t("dm + task delivery and draining", async () => {
    const members = await bus.loadMembers(root, "acme");
    const tgt = bus.resolveTargets(members, "sessA", "role:implementer");
    const sent = await bus.sendMessage(root, "acme", {
      type: "task",
      from: "sessA",
      fromName: "Alice",
      fromRole: "coordinator",
      to: "Bob",
      subject: "build parser",
      body: "Please build the parser module",
      priority: "high",
      targets: tgt.ids,
    });
    ok("send task", sent.ok && sent.delivered === 1);
    const inboxB = await bus.drainInbox(root, "acme", "sessB");
    ok("Bob received task", inboxB.length === 1);
    ok("task fields", inboxB[0].type === "task" && inboxB[0].priority === "high" && inboxB[0].fromName === "Alice");
    ok("inbox drained after read", (await bus.pendingCount(root, "acme", "sessB")) === 0);
    ok("Alice has no mail", (await bus.pendingCount(root, "acme", "sessA")) === 0);
  });

  await t("broadcast reaches everyone except sender", async () => {
    const members = await bus.loadMembers(root, "acme");
    const others = Object.keys(members).filter((id) => id !== "sessA");
    const sent = await bus.sendMessage(root, "acme", {
      type: "broadcast",
      from: "sessA",
      fromName: "Alice",
      fromRole: "coordinator",
      to: "everyone",
      body: "standup in 5",
      targets: others,
    });
    ok("broadcast delivered", sent.ok && sent.delivered === 1);
    const inboxB = await bus.drainInbox(root, "acme", "sessB");
    ok("Bob got broadcast", inboxB.some((m) => m.type === "broadcast"));
  });

  await t("board write/read/list", async () => {
    const bw = await bus.writeBoard(root, "acme", "design", "# Design\n\n- API: rest");
    ok("board write", bw.ok);
    const br = await bus.readBoard(root, "acme", "design");
    ok("board read content", br.ok && br.content.includes("API: rest"));
    const list = await bus.readBoard(root, "acme");
    ok("board list", list.ok && list.topics.includes("design"));
    const bad = await bus.writeBoard(root, "acme", "../escape", "x");
    ok("invalid topic rejected", !bad.ok);
  });

  await t("status update + roster", async () => {
    await bus.touchMember(root, "acme", "sessB", { status: "blocked on parser" });
    const members = await bus.loadMembers(root, "acme");
    ok("status persisted", members.sessB.status === "blocked on parser");
    const roster = bus.rosterList(members, "sessA");
    ok("roster sorted by name", roster[0].name === "Alice" && roster[1].name === "Bob");
  });

  await t("sync offline write (shutdown path)", async () => {
    const okSync = bus.setMemberStatusSync(root, "acme", "sessA", "offline");
    ok("sync write ok", okSync === true);
    const members = await bus.loadMembers(root, "acme");
    ok("status offline persisted", members.sessA.status === "offline");
    // revive via normal touch
    await bus.touchMember(root, "acme", "sessA", { status: "idle" });
    const revived = await bus.loadMembers(root, "acme");
    ok("revived to idle", revived.sessA.status === "idle");
    // no orphaned lock after sync write
    ok("no lock left behind", !fs.existsSync(path.join(bus.teamDir(root, "acme"), ".lock")));
  });

  await t("task board: create/list/transition with permissions", async () => {
    // Bob re-joins for task tests
    await bus.joinMember(root, "acme", { id: "sessB", name: "Bob", role: "implementer" });
    const created = await bus.createTask(root, "acme", {
      title: "build parser",
      body: "Implement the parser module",
      assignee: "role:implementer",
      criteria: ["parses JSON", "tests pass"],
      createdBy: "sessA",
      createdByName: "Alice",
    });
    ok("create task", created.ok && created.task.status === "queued");
    const tid = created.task.id;
    ok("task assignee role:implementer", created.task.assignee === "role:implementer");

    // wrong actor cannot start (Carol is not the assignee role)
    await bus.joinMember(root, "acme", { id: "sessC", name: "Carol", role: "reviewer" });
    const wrong = await bus.updateTask(root, "acme", tid, { status: "running" }, { id: "sessC", name: "Carol", role: "reviewer" });
    ok("wrong actor cannot start", !wrong.ok && wrong.error.includes("assignee"));

    // assignee role can start
    const start = await bus.updateTask(root, "acme", tid, { status: "running" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("assignee starts", start.ok && start.task.status === "running");

    // done without evidence is rejected (the typed-artifact gate)
    const noEvidence = await bus.updateTask(root, "acme", tid, { status: "done" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("done without evidence rejected", !noEvidence.ok && noEvidence.error.includes("evidence"));

    // done with evidence succeeds; creator gets a task_done DM
    const done = await bus.updateTask(
      root, "acme", tid, { status: "done", evidence: "crates/parser.rs: implemented; 12 tests pass" },
      { id: "sessB", name: "Bob", role: "implementer" },
    );
    ok("done with evidence", done.ok && done.task.status === "done" && done.task.evidence.includes("parser.rs"));
    const aliceInbox = await bus.drainInbox(root, "acme", "sessA");
    ok("creator notified of task_done", aliceInbox.some((m) => m.type === "task_done" && m.body.includes("parser.rs")));

    // dependency warning: task2 depends on unfinished task1
    const t1 = await bus.createTask(root, "acme", { title: "API spec", createdBy: "sessA", createdByName: "Alice" });
    const t2 = await bus.createTask(root, "acme", { title: "implement API", dependsOn: [t1.task.id], createdBy: "sessA", createdByName: "Alice" });
    const startWarn = await bus.updateTask(root, "acme", t2.task.id, { status: "running" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("dependency warning on start", startWarn.ok && startWarn.warnings.includes(t1.task.id));

    // reassign permission: only creator/coordinator
    const reassignWrong = await bus.updateTask(root, "acme", tid, { assignee: "Carol" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("non-creator cannot reassign", !reassignWrong.ok);
    const reassignOk = await bus.updateTask(root, "acme", tid, { assignee: "Carol" }, { id: "sessA", name: "Alice", role: "coordinator" });
    ok("coordinator can reassign", reassignOk.ok && reassignOk.task.assignee === "Carol");

    ok("tasks persisted to file", (await bus.loadTasks(root, "acme")).length >= 3);
  });

  await t("role change + leave", async () => {
    const r = await bus.setMemberRole(root, "acme", "sessB", "tech-lead");
    ok("role change", r.ok && r.member.role === "tech-lead");
    await bus.leaveMember(root, "acme", "sessB");
    const members = await bus.loadMembers(root, "acme");
    ok("member removed", !members.sessB);
  });

  await t("log appended", async () => {
    const log = await bus.readLog(root, "acme", 10);
    ok("log has entries", log.length >= 5);
    ok("log has message event", log.some((e) => e.event === "message"));
  });

  await t("dead-session name reclaim + team preset", async () => {
    const root2 = path.join(root, "reclaim");
    await bus.createTeam(root2, "team3", {});
    await bus.joinMember(root2, "team3", { id: "old-session", name: "Zed", role: "architect" });
    // graceful shutdown marks offline -> name is immediately reclaimable
    bus.setMemberStatusSync(root2, "team3", "old-session", "offline");
    const jr1 = await bus.joinMember(root2, "team3", { id: "new-session", name: "Zed", role: "architect" });
    ok("offline session name reclaimed on rejoin", jr1.ok);
    // a live member's name is NOT reclaimable
    await bus.joinMember(root2, "team3", { id: "live", name: "Ann", role: "implementer" });
    const blocked = await bus.joinMember(root2, "team3", { id: "intruder", name: "Ann", role: "implementer" });
    ok("live member name still protected", !blocked.ok);
    // stale heartbeat (crash/power loss, no offline mark) frees the name
    const members = await bus.loadMembers(root2, "team3");
    members["live"].lastSeen = Date.now() - (bus.STALE_MEMBER_MS + 1000);
    await bus.writeJsonAtomic(path.join(bus.teamDir(root2, "team3"), "members.json"), { members });
    const jr2 = await bus.joinMember(root2, "team3", { id: "revived", name: "Ann", role: "implementer" });
    ok("stale heartbeat name reclaimed on rejoin", jr2.ok);
    // preset tracks the intended roster
    const preset = await bus.loadPreset(root2, "team3");
    ok("preset exists with members", preset && preset.members.some((m) => m.name === "Zed") && preset.members.some((m) => m.name === "Ann"));
    await bus.setMemberRole(root2, "team3", "revived", "tech-lead");
    const preset2 = await bus.loadPreset(root2, "team3");
    ok("preset role tracks role changes", preset2.members.find((m) => m.name === "Ann").role === "tech-lead");
    await bus.leaveMember(root2, "team3", "revived");
    const preset3 = await bus.loadPreset(root2, "team3");
    ok("preset drops leavers", !preset3.members.some((m) => m.name === "Ann"));
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("standing briefing storage", async () => {
    const root2 = path.join(root, "brief");
    await bus.createTeam(root2, "b", {});
    ok("no brief initially", (await bus.loadBrief(root2, "b")) === null);
    const set = await bus.saveBrief(root2, "b", "Ship v2 by Friday. Quality over speed.");
    ok("save brief", set.ok);
    const got = await bus.loadBrief(root2, "b");
    ok("load brief", got && got.includes("Friday"));
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("multi-role members (comma-separated)", async () => {
    const root2 = path.join(root, "multirole");
    await bus.createTeam(root2, "m", {});
    await bus.joinMember(root2, "m", { id: "opt", name: "Optimus", role: "coordinator, reviewer" });
    await bus.joinMember(root2, "m", { id: "bee", name: "Bee", role: "implementer" });
    const members = await bus.loadMembers(root2, "m");
    const asReviewer = bus.resolveTargets(members, "bee", "role:reviewer");
    const asCoord = bus.resolveTargets(members, "bee", "role:coordinator");
    ok("role:reviewer resolves to multi-role member", asReviewer.ids.length === 1 && asReviewer.ids[0] === "opt");
    ok("role:coordinator resolves to multi-role member", asCoord.ids.length === 1 && asCoord.ids[0] === "opt");
    const t = await bus.createTask(root2, "m", { title: "work", assignee: "role:implementer", createdBy: "opt", createdByName: "Optimus" });
    const r = await bus.createTask(root2, "m", { title: "rev", kind: "review", reviewOf: t.task.id, assignee: "role:reviewer", createdBy: "opt", createdByName: "Optimus" });
    const done = await bus.updateTask(root2, "m", r.task.id, { status: "done", evidence: "ok" }, { id: "opt", name: "Optimus", role: "coordinator, reviewer" });
    ok("multi-role member passes review task", done.ok);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("confidence parsing + low-confidence escalation", async () => {
    ok("parse: low word", bus.parseConfidence("low") === "low");
    ok("parse: negation", bus.parseConfidence("not confident") === "low");
    ok("parse: medium", bus.parseConfidence("moderate") === "medium");
    ok("parse: high", bus.parseConfidence("high") === "high");
    ok("parse: percent", bus.parseConfidence("72%") === "medium");
    ok("parse: 0-1 score", bus.parseConfidence("0.9") === "high");
    ok("parse: blank -> null", bus.parseConfidence("") === null);

    const root2 = path.join(root, "conf");
    await bus.createTeam(root2, "c", {});
    await bus.joinMember(root2, "c", { id: "coord", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "c", { id: "imp", name: "Bob", role: "implementer" });
    await bus.joinMember(root2, "c", { id: "res", name: "Ghost", role: "researcher" });
    const t = await bus.createTask(root2, "c", { title: "parser", assignee: "role:implementer", createdBy: "coord", createdByName: "Alice" });

    // high confidence -> no escalation
    const hi = await bus.updateTask(root2, "c", t.task.id, { status: "done", evidence: "works", confidence: "high" }, { id: "imp", name: "Bob", role: "implementer" });
    ok("high confidence: no escalation", hi.ok && hi.lowConfidence !== true);

    // low confidence -> coordinator notified + research task created for researcher
    const t2 = await bus.createTask(root2, "c", { title: "config parser", assignee: "role:implementer", createdBy: "coord", createdByName: "Alice" });
    const lo = await bus.updateTask(root2, "c", t2.task.id, { status: "done", evidence: "mostly works", confidence: "low" }, { id: "imp", name: "Bob", role: "implementer" });
    ok("low confidence flagged", lo.ok && lo.lowConfidence === true && lo.researchTaskId);
    const tasks = await bus.loadTasks(root2, "c");
    const research = tasks.find((x) => x.id === lo.researchTaskId);
    ok("research follow-up created", research && research.assignee === "role:researcher" && research.dependsOn.includes(t2.task.id));
    const coordIn = await bus.drainInbox(root2, "c", "coord");
    ok("coordinator got LOW CONFIDENCE notice", coordIn.some((m) => m.type === "task_low_confidence" && m.body.includes(lo.researchTaskId)));
    const resIn = await bus.drainInbox(root2, "c", "res");
    ok("researcher got the follow-up task", resIn.some((m) => m.type === "task" && m.body.includes(lo.researchTaskId)));
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("wake flag + team settings", async () => {
    const root2 = path.join(root, "wake");
    await bus.createTeam(root2, "w", {});
    await bus.joinMember(root2, "w", { id: "a", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "w", { id: "b", name: "Bob", role: "implementer" });
    // normal dm: not wake
    await bus.sendMessage(root2, "w", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "Bob", body: "hi", targets: ["b"] });
    ok("normal dm not wake", (await bus.hasWakePending(root2, "w", "b")) === false);
    // wake dm
    await bus.sendMessage(root2, "w", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "Bob", body: "status check", wake: true, targets: ["b"] });
    ok("wake dm detected", (await bus.hasWakePending(root2, "w", "b")) === true);
    await bus.drainInbox(root2, "w", "b");
    ok("wake cleared after drain", (await bus.hasWakePending(root2, "w", "b")) === false);
    // settings toggle
    const off = await bus.setTeamSetting(root2, "w", { autoRespond: false });
    ok("autoRespond off persisted", off.ok && off.team.autoRespond === false);
    const on = await bus.setTeamSetting(root2, "w", { autoRespond: true });
    ok("autoRespond on persisted", on.ok && on.team.autoRespond === true);
    ok("interject untouched", (await bus.loadTeam(root2, "w")).interject === true);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("wake echo, liveness, task notifications, awaitReplies", async () => {
    const root2 = path.join(root, "wake2");
    await bus.createTeam(root2, "w2", {});
    await bus.joinMember(root2, "w2", { id: "a", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "w2", { id: "b", name: "Bob", role: "implementer" });
    // dead member detection
    await bus.joinMember(root2, "w2", { id: "c", name: "Carol", role: "researcher" });
    bus.setMemberStatusSync(root2, "w2", "c", "offline");
    const now = Date.now();
    ok("offline member is dead", bus.isMemberDead((await bus.loadMembers(root2, "w2")).c, now));
    ok("live member not dead", !bus.isMemberDead((await bus.loadMembers(root2, "w2")).b, now));
    // sendMessage: wake + offlineTargets + log
    const sent = await bus.sendMessage(root2, "w2", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "Carol", body: "hi", wake: true, targets: ["c"] });
    ok("send echoes wake", sent.wake === true);
    ok("offline target flagged", sent.offlineTargets.length === 1 && sent.offlineTargets[0].name === "Carol");
    const log = await bus.readLog(root2, "w2", 5);
    ok("log records wake", log.some((e) => e.event === "message" && e.wake === true));
    // task assignment notification wakes the assignee
    const t = await bus.createTask(root2, "w2", { title: "x", assignee: "role:implementer", createdBy: "a", createdByName: "Alice" });
    ok("task created", t.ok);
    const bobIn = await bus.drainInbox(root2, "w2", "b");
    ok("task assignment notification is wake", bobIn.some((m) => m.type === "task" && m.wake === true));
    // awaitReplies: inject a reply mid-poll
    const waiter = bus.awaitReplies(root2, "w2", "a", ["Bob"], { mode: "all", timeoutMs: 3000, pollMs: 50 });
    await new Promise((r) => setTimeout(r, 200));
    await bus.sendMessage(root2, "w2", { type: "dm", from: "b", fromName: "Bob", fromRole: "implementer", to: "Alice", body: "here I am", targets: ["a"] });
    const res = await waiter;
    ok("awaitReplies got the reply", res.replied.length === 1 && res.replied[0].name === "Bob" && !res.timedOut);
    // awaitReplies timeout path
    const res2 = await bus.awaitReplies(root2, "w2", "a", ["Ghost"], { mode: "all", timeoutMs: 300, pollMs: 50 });
    ok("awaitReplies times out with missing", res2.missing.includes("Ghost") && res2.timedOut);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("airtight reply wake", async () => {
    const root2 = path.join(root, "reply");
    await bus.createTeam(root2, "r", {});
    await bus.joinMember(root2, "r", { id: "a", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "r", { id: "b", name: "Bob", role: "implementer" });
    // no prior contact -> no auto-wake
    const first = await bus.sendMessage(root2, "r", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "Bob", body: "hi", targets: ["b"] });
    ok("fresh dm not auto-wake", first.wake === false);
    await bus.drainInbox(root2, "r", "b");
    // Bob replies to Alice WITHOUT passing wake -> must auto-wake (reply rule)
    const reply = await bus.sendMessage(root2, "r", { type: "dm", from: "b", fromName: "Bob", fromRole: "implementer", to: "Alice", body: "here", targets: ["a"] });
    ok("reply auto-wakes even without wake flag", reply.wake === true && reply.isReply === true);
    await bus.drainInbox(root2, "r", "a");
    // reply to a broadcast also wakes
    await bus.sendMessage(root2, "r", { type: "broadcast", from: "a", fromName: "Alice", fromRole: "coordinator", to: "everyone", body: "standup", targets: ["b"] });
    await bus.drainInbox(root2, "r", "b");
    const br = await bus.sendMessage(root2, "r", { type: "dm", from: "b", fromName: "Bob", fromRole: "implementer", to: "Alice", body: "re: standup", targets: ["a"] });
    ok("reply to broadcast auto-wakes", br.wake === true);
    await bus.drainInbox(root2, "r", "a");
    // explicit replyTo also wakes
    const rt = await bus.sendMessage(root2, "r", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "Bob", body: "thanks", replyTo: "msg_x", targets: ["b"] });
    ok("explicit replyTo wakes", rt.wake === true);
    // role: target does not reply-detect (no single person)
    const roleSend = await bus.sendMessage(root2, "r", { type: "dm", from: "a", fromName: "Alice", fromRole: "coordinator", to: "role:implementer", body: "all hands", targets: ["b"] });
    ok("role: target not auto-wake via reply rule", roleSend.wake === false && roleSend.isReply === false);
    // reply rule survives a restart (stateless: it reads the audit log)
    const again = await bus.sendMessage(root2, "r", { type: "dm", from: "b", fromName: "Bob", fromRole: "implementer", to: "Alice", body: "follow up", targets: ["a"] });
    ok("reply detected from log (restart-safe)", again.isReply === true);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("kick member (coordinator removal)", async () => {
    const root2 = path.join(root, "kick");
    await bus.createTeam(root2, "k", {});
    await bus.joinMember(root2, "k", { id: "a", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "k", { id: "b", name: "Bob", role: "implementer" });
    // unknown name
    const miss = await bus.kickMember(root2, "k", "Nobody", { byId: "a", byName: "Alice" });
    ok("kick unknown member errors", !miss.ok);
    // kick Bob
    const kicked = await bus.kickMember(root2, "k", "Bob", { byId: "a", byName: "Alice", reason: "inactive" });
    ok("kick ok", kicked.ok && kicked.member.name === "Bob" && kicked.member.role === "implementer");
    const members = await bus.loadMembers(root2, "k");
    ok("kicked member removed from roster", !members.b);
    const preset = await bus.loadPreset(root2, "k");
    ok("kicked member removed from preset", !preset.members.some((m) => m.name === "Bob"));
    const log = await bus.readLog(root2, "k", 10);
    ok("kick logged with reason", log.some((e) => e.event === "member_kicked" && e.reason === "inactive"));
    // kicked member's inbox has the notice (their process would see it)
    const bobIn = await bus.drainInbox(root2, "k", "b");
    ok("kicked member notified", bobIn.some((m) => m.type === "system" && m.body.includes("removed from team")));
    // kick self-guard is coordinator-side; bus-level re-kick fails
    const again = await bus.kickMember(root2, "k", "Bob", { byId: "a", byName: "Alice" });
    ok("re-kick errors", !again.ok);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("checkin records (non-blocking status checks)", async () => {
    const root2 = path.join(root, "chk");
    await bus.createTeam(root2, "c", {});
    await bus.joinMember(root2, "c", { id: "a", name: "Alice", role: "coordinator" });
    await bus.joinMember(root2, "c", { id: "b", name: "Bob", role: "implementer" });
    await bus.joinMember(root2, "c", { id: "d", name: "Dora", role: "implementer" });
    const rec = await bus.setCheckin(root2, "c", "a", { question: "status?", targets: ["Bob", "Dora"] });
    ok("checkin created", rec && rec.targets.length === 2 && rec.replied.length === 0);
    // replies recorded progressively (Bob first, then Dora)
    let r = await bus.recordCheckinReplies(root2, "c", "a", ["Bob"]);
    ok("first reply recorded", r.replied.length === 1 && r.replied[0] === "Bob");
    r = await bus.recordCheckinReplies(root2, "c", "a", ["Dora", "Bob"]); // duplicate Bob ignored
    ok("second reply recorded, dup ignored", r.replied.length === 2 && r.replied.includes("Dora"));
    r = await bus.recordCheckinReplies(root2, "c", "a", ["Stranger"]);
    ok("non-target sender ignored", r.replied.length === 2);
    const got = await bus.getCheckin(root2, "c", "a");
    ok("checkin read back", got && got.question === "status?" && got.replied.length === 2);
    // replacing checkin resets progress
    const rec2 = await bus.setCheckin(root2, "c", "a", { question: "second round", targets: ["Dora"] });
    ok("re-checkin replaces and resets", rec2.replied.length === 0 && rec2.question === "second round");
    // clear removes it
    await bus.clearCheckin(root2, "c", "a");
    ok("checkin cleared", (await bus.getCheckin(root2, "c", "a")) === null);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("resolveTeamName (case-insensitive team names)", async () => {
    const root2 = path.join(root, "names");
    await bus.createTeam(root2, "Zilla", {});
    ok("exact match", (await bus.resolveTeamName(root2, "Zilla")) === "Zilla");
    ok("fuzzy lowercase", (await bus.resolveTeamName(root2, "zilla")) === "Zilla");
    ok("fuzzy mixed case", (await bus.resolveTeamName(root2, "ZiLLa")) === "Zilla");
    ok("unknown team -> null", (await bus.resolveTeamName(root2, "nope")) === null);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("role aliases (custom role names keep capabilities)", async () => {
    ok("Hub is a coordinator", bus.hasRole("Hub", "coordinator"));
    ok("Math is a planner", bus.hasRole("Math", "planner"));
    ok("Executor is an implementer", bus.hasRole("Executor", "implementer"));
    ok("Scout is a researcher", bus.hasRole("Scout", "researcher"));
    ok("Auditor is a reviewer", bus.hasRole("Auditor", "reviewer"));
    ok("multi-role with custom name", bus.hasRole("Hub, reviewer", "reviewer"));
    ok("case-insensitive", bus.hasRole("hub", "COORDINATOR"));
    ok("exact roles still work", bus.hasRole("coordinator", "coordinator") && bus.hasRole("implementer", "implementer"));
    ok("no false positive", !bus.hasRole("Scout", "coordinator") && !bus.hasRole("Math", "implementer"));
    // fanout: role:coordinator resolves a Hub member
    const root2 = path.join(root, "roles");
    await bus.createTeam(root2, "r", {});
    await bus.joinMember(root2, "r", { id: "z", name: "Zed", role: "Hub" });
    await bus.joinMember(root2, "r", { id: "m", name: "Mint", role: "Math" });
    const members = await bus.loadMembers(root2, "r");
    const hubs = bus.resolveTargets(members, "m", "role:coordinator");
    ok("role:coordinator resolves Hub", hubs.ids.length === 1 && hubs.ids[0] === "z");
    const doers = bus.resolveTargets(members, "z", "role:implementer");
    ok("role:implementer resolves none (no Executor)", doers.error);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("autoRespond defaults ON (no manual prompt needed)", async () => {
    const root2 = path.join(root, "ar");
    await bus.createTeam(root2, "a", {});
    const meta = await bus.loadTeam(root2, "a");
    ok("autoRespond defaults true", meta.autoRespond === true);
    await bus.setTeamSetting(root2, "a", { autoRespond: false });
    ok("explicitly disableable", (await bus.loadTeam(root2, "a")).autoRespond === false);
    await bus.setTeamSetting(root2, "a", { autoRespond: true });
    ok("re-enableable", (await bus.loadTeam(root2, "a")).autoRespond === true);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("self-ping timers (team later)", async () => {
    const root2 = path.join(root, "tms");
    await bus.createTeam(root2, "t", {});
    await bus.joinMember(root2, "t", { id: "a", name: "Alice", role: "coordinator" });
    // minutes-based
    const r1 = await bus.setTimer(root2, "t", "a", { minutes: 30, body: "check market" });
    ok("minutes timer set", r1.ok && r1.timer.body === "check market" && r1.timer.dueAt > Date.now() + 29 * 60 * 1000);
    // at-based (HH:MM): next occurrence
    const d = new Date(Date.now() + 3600 * 1000);
    const hh = d.getHours(), mm = d.getMinutes();
    const r2 = await bus.setTimer(root2, "t", "a", { at: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, body: "hourly" });
    ok("at timer set ~1h out", r2.ok && Math.abs(r2.timer.dueAt - (Date.now() + 3600 * 1000)) < 90 * 1000);
    // errors
    ok("bad time rejected", !(await bus.setTimer(root2, "t", "a", { at: "25:99" })).ok);
    ok("bad minutes rejected", !(await bus.setTimer(root2, "t", "a", { minutes: -5 })).ok);
    // list + cancel
    const list = await bus.listTimers(root2, "t", "a");
    ok("list has 2 timers", list.length === 2);
    ok("cancel works", (await bus.cancelTimer(root2, "t", "a", list[0].id)).ok);
    ok("cancel unknown errors", !(await bus.cancelTimer(root2, "t", "a", "nope")).ok);
    // claim: due timers claimed+removed, future ones stay
    await bus.setTimer(root2, "t", "a", { minutes: -1 === -1 ? 0.00001 : 1, body: "due now" });
    const due = await bus.claimDueTimers(root2, "t", "a", Date.now() + 1000);
    ok("due timer claimed", due.length === 1 && due[0].body === "due now");
    ok("claimed timer removed", (await bus.listTimers(root2, "t", "a")).length === 1);
    ok("future timers not claimed", (await bus.claimDueTimers(root2, "t", "a", Date.now())).length === 0);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("standing cadence timers (autoTimers config)", async () => {
    const root2 = path.join(root, "stt");
    await bus.createTeam(root2, "s", {});
    const res = await bus.setTeamSetting(root2, "s", { autoTimers: [
      { name: "Zed", minutes: 15, tag: "zed_cycle", body: "run the next cycle" },
      { name: "Daisy", minutes: 30, tag: "daisy_scout", body: "scout scan" },
      { name: "", minutes: 5, body: "bad" }, // filtered: no name
    ] });
    ok("autoTimers stored", res.ok && res.team.autoTimers.length === 2);
    ok("minutes clamped", res.team.autoTimers[0].minutes === 15);
    ok("tag kept", res.team.autoTimers[1].tag === "daisy_scout");
    // setTimer stores the tag so the extension can dedup/re-arm
    const t = await bus.setTimer(root2, "s", "a", { minutes: 15, body: "cycle", tag: "zed_cycle" });
    ok("tag persisted on timer", t.ok && t.timer.tag === "zed_cycle");
    const claimed = await bus.claimDueTimers(root2, "s", "a", Date.now() + 1e12);
    ok("claimed timer keeps tag", claimed.length === 1 && claimed[0].tag === "zed_cycle");
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("web search via SearXNG (resolveSearchUrl + error handling)", async () => {
    // URL resolution chain: team.json -> env -> default
    ok("default localhost", bus.resolveSearchUrl({}, null) === "http://127.0.0.1:8888");
    ok("JCODE_SEARXNG_URL honored", bus.resolveSearchUrl({ JCODE_SEARXNG_URL: "http://127.0.0.1:9999/" }, null) === "http://127.0.0.1:9999");
    ok("PI_TEAM_SEARXNG_URL wins over JCODE", bus.resolveSearchUrl({ PI_TEAM_SEARXNG_URL: "http://a:1", JCODE_SEARXNG_URL: "http://b:2" }, null) === "http://a:1");
    ok("team.json searchUrl wins", bus.resolveSearchUrl({ SEARXNG_URL: "http://env:1" }, { searchUrl: "http://team:1/" }) === "http://team:1");
    // error handling: unreachable URL -> clean error, not a throw
    const r = await bus.searchWeb("test", { env: { PI_TEAM_SEARXNG_URL: "http://127.0.0.1:1" }, timeoutMs: 1500 });
    ok("unreachable searxng errors cleanly", !r.ok && typeof r.error === "string" && r.error.length > 0);
    // empty query
    ok("empty query rejected", !(await bus.searchWeb("  ")).ok);
  });

  await t("cross-team DMs (Team/Member addressing + both-side audit + reply rule)", async () => {
    const root2 = path.join(root, "xteam");
    await bus.createTeam(root2, "Alpha", {});
    await bus.createTeam(root2, "Zilla", {});
    await bus.joinMember(root2, "Alpha", { id: "a1", name: "Optimus", role: "coordinator" });
    await bus.joinMember(root2, "Zilla", { id: "z1", name: "Zed", role: "Hub" });
    await bus.joinMember(root2, "Zilla", { id: "z2", name: "Mint", role: "Math" });
    const zMembers = await bus.loadMembers(root2, "Zilla");
    // resolution
    const r1 = await bus.resolveCrossTarget(root2, "Zilla/Zed");
    ok("cross resolves member", r1 && r1.team === "Zilla" && r1.names[0] === "Zed");
    ok("cross case-insensitive team", (await bus.resolveCrossTarget(root2, "zilla/zed")).team === "Zilla");
    const rRole = await bus.resolveCrossTarget(root2, "Zilla/role:coordinator");
    ok("cross role resolves Hub alias", rRole && rRole.names[0] === "Zed");
    ok("cross unknown team errors", (await bus.resolveCrossTarget(root2, "Nope/Zed")).error);
    ok("cross unknown member errors", (await bus.resolveCrossTarget(root2, "Zilla/Nobody")).error);
    ok("non-cross returns null", (await bus.resolveCrossTarget(root2, "Zed")) === null);
    // delivery: Optimus -> Zed, lands in Zilla's inbox + both audit logs
    const sent = await bus.sendMessage(root2, "Zilla", {
      type: "dm", from: "a1", fromName: "Optimus", fromRole: "coordinator", fromTeam: "Alpha",
      to: "Zed", subject: "hello", body: "coordinate on the cycle", wake: true, targets: ["z1"],
    }, { members: zMembers, logTeams: ["Zilla", "Alpha"] });
    ok("cross dm sent", sent.ok);
    const zedInbox = await bus.drainInbox(root2, "Zilla", "z1");
    ok("delivered to target team inbox", zedInbox.some((m) => m.fromName === "Optimus" && m.fromTeam === "Alpha"));
    ok("both audit logs have it", (await bus.readLog(root2, "Zilla", 50)).some((e) => e.event === "message" && e.from === "Optimus")
      && (await bus.readLog(root2, "Alpha", 50)).some((e) => e.event === "message" && e.from === "Optimus"));
    // reply rule across the boundary: Zed -> Optimus is a reply (wake forced)
    const aMembers = await bus.loadMembers(root2, "Alpha");
    const reply = await bus.sendMessage(root2, "Alpha", {
      type: "dm", from: "z1", fromName: "Zed", fromRole: "Hub", fromTeam: "Zilla",
      to: "Optimus", subject: "re: hello", body: "sure, 15-min cycle", wake: false, targets: ["a1"],
    }, { members: aMembers, logTeams: ["Alpha", "Zilla"] });
    ok("cross reply classified as reply (airtight wake)", reply.ok && reply.isReply === true && reply.wake === true);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("cross-team lead-to-lead policy", async () => {
    const root2 = path.join(root, "leads");
    await bus.createTeam(root2, "Alpha", {});
    await bus.createTeam(root2, "Zilla", {});
    await bus.joinMember(root2, "Alpha", { id: "a1", name: "Optimus", role: "coordinator" });
    await bus.joinMember(root2, "Alpha", { id: "a2", name: "Carol", role: "implementer" });
    await bus.joinMember(root2, "Zilla", { id: "z1", name: "Zed", role: "Hub" });
    await bus.joinMember(root2, "Zilla", { id: "z2", name: "Mint", role: "Math" });
    const zMembers = await bus.loadMembers(root2, "Zilla");
    // lead sender -> lead target: allowed
    const r1 = await bus.resolveCrossTarget(root2, "Zilla/Zed");
    ok("lead-to-lead allowed", bus.crossTeamCheck("coordinator", zMembers, r1.ids).ok === true);
    const r2 = await bus.resolveCrossTarget(root2, "Zilla/role:coordinator");
    ok("role:coordinator target allowed", bus.crossTeamCheck("Hub", zMembers, r2.ids).ok === true);
    // non-lead sender blocked
    const blocked1 = bus.crossTeamCheck("implementer", zMembers, r1.ids);
    ok("non-lead sender blocked", !blocked1.ok && blocked1.error.includes("lead-only"));
    const blocked2 = bus.crossTeamCheck("Math", zMembers, r1.ids);
    ok("non-lead alias sender blocked", !blocked2.ok);
    // lead sender -> non-lead target blocked
    const r3 = await bus.resolveCrossTarget(root2, "Zilla/Mint");
    const blocked3 = bus.crossTeamCheck("coordinator", zMembers, r3.ids);
    ok("non-lead target blocked", !blocked3.ok && blocked3.error.includes("Mint"));
    // mixed targets (coordinator + non) blocked
    const blocked4 = bus.crossTeamCheck("coordinator", zMembers, [...r1.ids, ...r3.ids]);
    ok("mixed targets blocked", !blocked4.ok);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("cross-team handler sequence (resolve -> policy -> send) end-to-end", async () => {
    const root2 = path.join(root, "xend");
    await bus.createTeam(root2, "LeadA", {});
    await bus.createTeam(root2, "LeadB", {});
    await bus.joinMember(root2, "LeadB", { id: "lb1", name: "Zed", role: "Hub" });
    await bus.joinMember(root2, "LeadB", { id: "lb2", name: "Mint", role: "Math" });
    const zMembers = await bus.loadMembers(root2, "LeadB");
    // CASE 1: Optimus (coordinator) -> LeadB/Zed: allowed, delivered
    const c1 = await bus.resolveCrossTarget(root2, "LeadB/Zed");
    const p1 = bus.crossTeamCheck("coordinator", zMembers, c1.ids);
    ok("case1 policy ok", p1.ok);
    const s1 = await bus.sendMessage(root2, "LeadB", {
      type: "dm", from: "a1", fromName: "Optimus", fromRole: "coordinator", fromTeam: "LeadA",
      to: "Zed", body: "coordinate", wake: true, targets: c1.ids,
    }, { members: zMembers, logTeams: ["LeadB", "LeadA"] });
    ok("case1 delivered", s1.ok && (await bus.drainInbox(root2, "LeadB", "lb1")).length === 1);
    // CASE 2: Optimus -> LeadB/Mint: policy blocks (Mint not a lead)
    const c2 = await bus.resolveCrossTarget(root2, "LeadB/Mint");
    const p2 = bus.crossTeamCheck("coordinator", zMembers, c2.ids);
    ok("case2 blocked: non-lead target", !p2.ok && p2.error.includes("Mint"));
    // CASE 3: Carol (implementer) -> LeadB/Zed: policy blocks (sender not a lead)
    const p3 = bus.crossTeamCheck("implementer", zMembers, c1.ids);
    ok("case3 blocked: non-lead sender", !p3.ok && p3.error.includes("lead-only"));
    // CASE 4: role target resolves to the lead and passes
    const c4 = await bus.resolveCrossTarget(root2, "LeadB/role:coordinator");
    ok("case4 role target ok", bus.crossTeamCheck("Hub", zMembers, c4.ids).ok === true);
    fs.rmSync(root2, { recursive: true, force: true });
  });

  await t("project memory (MEMORY.md)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memo-"));
    // first append seeds the header
    const a = await bus.memoAppend(dir, { team: "Alpha", name: "Bee", role: "implementer", body: "Chose postgres over mysql." });
    ok("memo create", a.ok && a.file.endsWith("MEMORY.md"));
    let txt = await bus.memoRead(dir);
    ok("header seeded", txt.includes("# Project Memory — team Alpha"));
    ok("entry tagged with author+role", txt.includes("Bee (implementer)"));
    ok("body recorded", txt.includes("postgres"));
    // second append adds another entry without duplicating the header
    await bus.memoAppend(dir, { team: "Alpha", name: "Ghost", role: "researcher", body: "Vendor lib X is unmaintained." });
    txt = await bus.memoRead(dir);
    ok("header not duplicated", txt.split("# Project Memory").length === 2);
    ok("second entry present", txt.includes("Ghost (researcher)") && txt.includes("unmaintained"));
    // concurrent appends don't lose entries
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => bus.memoAppend(dir, { team: "Alpha", name: `A${i}`, role: "worker", body: `note ${i}` })),
    );
    txt = await bus.memoRead(dir);
    ok("all concurrent notes survived", [0,1,2,3,4,5].every((i) => txt.includes(`note ${i}`)));
    ok("no lock left behind", !fs.existsSync(path.join(dir, "agent-team", ".lock")));
    ok("file lives under agent-team/", fs.existsSync(path.join(dir, "agent-team", "MEMORY.md")));
    ok("no stray root-level MEMORY.md", !fs.existsSync(path.join(dir, "MEMORY.md")));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t("concurrent joins do not lose members", async () => {
    const root2 = path.join(root, "concurrent");
    await bus.createTeam(root2, "team2", {});
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        bus.joinMember(root2, "team2", { id: `s${i}`, name: `M${i}`, role: "worker" }),
      ),
    );
    const members = await bus.loadMembers(root2, "team2");
    ok("all 8 concurrent joins survived", Object.keys(members).length === 8);
  });

  await t("hard dep gate + review bounce + hygiene", async () => {
    // Rejoin members with the roles this test needs (earlier tests changed/removed them).
    await bus.joinMember(root, "acme", { id: "sessB", name: "Bob", role: "implementer" });
    await bus.joinMember(root, "acme", { id: "sessC", name: "Carol", role: "reviewer" });
    // hard dep gate on done
    const dep1 = await bus.createTask(root, "acme", { title: "API spec", createdBy: "sessA", createdByName: "Alice" });
    const dep2 = await bus.createTask(root, "acme", { title: "implement API", dependsOn: [dep1.task.id], createdBy: "sessA", createdByName: "Alice" });
    const gated = await bus.updateTask(root, "acme", dep2.task.id, { status: "done", evidence: "done" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("done blocked by unfinished dep", !gated.ok && gated.error.includes("dep_override"));
    const overridden = await bus.updateTask(root, "acme", dep2.task.id, { status: "done", evidence: "done", depOverride: "coordinator deferred spec" }, { id: "sessB", name: "Bob", role: "implementer" });
    ok("dep_override accepts with warning", overridden.ok && overridden.warnings.some((w) => w.includes("dep_override")));

    // review task kind + bounce
    const work = await bus.createTask(root, "acme", { title: "feature X", assignee: "role:implementer", createdBy: "sessA", createdByName: "Alice" });
    const review = await bus.createTask(root, "acme", { title: "review feature X", kind: "review", reviewOf: work.task.id, assignee: "role:reviewer", createdBy: "sessA", createdByName: "Alice" });
    ok("review task created", review.ok && review.task.kind === "review");
    const badReview = await bus.createTask(root, "acme", { title: "bad", kind: "review", reviewOf: "t_nope", createdBy: "sessA", createdByName: "Alice" });
    ok("review of unknown task rejected", !badReview.ok);
    const sameRole = await bus.createTask(root, "acme", { title: "self-review", kind: "review", reviewOf: work.task.id, assignee: "role:implementer", createdBy: "sessA", createdByName: "Alice" });
    ok("same-role reviewer warns", sameRole.ok && sameRole.warnings.length > 0);

    await bus.updateTask(root, "acme", work.task.id, { status: "done", evidence: "implemented" }, { id: "sessB", name: "Bob", role: "implementer" });
    const bounce = await bus.updateTask(root, "acme", review.task.id, { status: "failed", reason: "edge case" }, { id: "sessC", name: "Carol", role: "reviewer" });
    ok("review fail bounces work", bounce.ok && bounce.bouncedTaskId === work.task.id);
    const tasks = await bus.loadTasks(root, "acme");
    ok("work back to running", tasks.find((x) => x.id === work.task.id).status === "running");
    const bobIn = await bus.drainInbox(root, "acme", "sessB");
    ok("implementer notified of bounce", bobIn.some((m) => m.type === "task_bounced"));
    // reviewer passes the review while the work is still bounced (running)
    // -> the work is auto-accepted as done
    const pass = await bus.updateTask(root, "acme", review.task.id, { status: "done", evidence: "expiry handled; looks good" }, { id: "sessC", name: "Carol", role: "reviewer" });
    ok("review pass accepts work", pass.ok && pass.acceptedTaskId === work.task.id);
    const afterPass = (await bus.loadTasks(root, "acme")).find((x) => x.id === work.task.id);
    ok("work done after review pass", afterPass.status === "done");
    // blocked escalates to coordinator
    await bus.createTask(root, "acme", { title: "flaky thing", assignee: "role:implementer", createdBy: "sessA", createdByName: "Alice" });
    const flaky = (await bus.loadTasks(root, "acme")).find((x) => x.title === "flaky thing");
    await bus.updateTask(root, "acme", flaky.id, { status: "blocked", reason: "dep missing" }, { id: "sessB", name: "Bob", role: "implementer" });
    const aliceIn = await bus.drainInbox(root, "acme", "sessA");
    ok("coordinator notified of blocked", aliceIn.some((m) => m.type === "task_blocked" && m.body.includes("dep missing")));

    // hygiene: prune + sweep stale tmp
    const pruned = await bus.pruneMembers(root, "acme", { olderThanMs: 0 });
    ok("prune removes stale members", pruned.removed >= 2);
    const tmpFile = path.join(bus.teamDir(root, "acme"), "inbox", "sessA", "x.tmp-123");
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, "stale");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(tmpFile, old, old);
    await bus.sweepTeam(root, "acme");
    ok("sweep removes stale tmp files", !fs.existsSync(tmpFile));

    // log rotation (simulate a huge log, then confirm append rotates)
    const logFile = path.join(bus.teamDir(root, "acme"), "log.jsonl");
    fs.writeFileSync(logFile, "x".repeat(bus.TEAM_LOG_MAX_BYTES + 1000));
    await bus.appendTeamLog(root, "acme", { ts: Date.now(), event: "rotation_test" });
    ok("oversized log rotated", fs.statSync(logFile).size < bus.TEAM_LOG_MAX_BYTES);
    const rotated = fs.readdirSync(bus.teamDir(root, "acme")).filter((f) => f.startsWith("log.jsonl."));
    ok("rotated file kept", rotated.length === 1);
  });


  console.log(`\nAll bus tests passed (${passed} assertions).`);
  fs.rmSync(root, { recursive: true, force: true });
};

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
