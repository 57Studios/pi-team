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

  console.log(`\nAll bus tests passed (${passed} assertions).`);
  fs.rmSync(root, { recursive: true, force: true });
};

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
