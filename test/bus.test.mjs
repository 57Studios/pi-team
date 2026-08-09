// Unit tests for the pi-team bus. Run: node test/bus.test.mjs
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as bus from "../bus.mjs";

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
