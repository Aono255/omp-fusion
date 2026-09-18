import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(process.argv[2]);
const data = JSON.parse(readFileSync(join(root, "results.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
assert.equal(
  data.length,
  18,
  "Need complete frozen matrix; missing runs cannot disappear",
);
assert.equal(new Set(data.map((r) => r.task + "/" + r.config)).size, 18);
for (const task of manifest.tasks)
  for (const config of manifest.configs)
    assert.ok(data.some((r) => r.task === task.id && r.config === config.id));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function totalTokens(r) {
  const lead = ["input", "output", "cacheRead", "cacheWrite"].map(
    (k) => r.lead[k],
  );
  if (lead.some((v) => v === null)) return null;
  const hasWorker = r.worker.messages > 0;
  if (
    !hasWorker &&
    (r.workerIds.length || r.calls.some((c) => c.tool === "task"))
  )
    return null;
  const worker = hasWorker
    ? ["input", "output", "cacheRead", "cacheWrite"].map((k) => r.worker[k])
    : [0, 0, 0, 0];
  return worker.some((v) => v === null)
    ? null
    : [...lead, ...worker].reduce((a, b) => a + b, 0);
}
const cells = manifest.configs.map((c) => {
  const rs = data.filter((r) => r.config === c.id);
  const ts = rs.map(totalTokens);
  return {
    config: c.id,
    n: rs.length,
    success: rs.filter((r) => r.success).length,
    meanSeconds: mean(rs.map((r) => r.elapsedMs / 1000)),
    meanTokens: ts.every((t) => t !== null) ? mean(ts) : null,
    workerRuns: rs.filter((r) => r.workerIds.length).length,
    overlapRuns: rs.filter((r) => r.overlappingLeadTools.length).length,
    takeoverAttempts: rs.reduce((s, r) => s + r.takeovers.length, 0),
    blockedExecutions: rs.reduce((s, r) => s + r.blockedExecutions, 0),
  };
});
const factors = ["brief", "async", "gate"].map((factor, bit) => {
  const pairs = [];
  for (const task of manifest.tasks)
    for (let n = 0; n < 8; n++) {
      const mask = 1 << (2 - bit);
      if (n & mask) continue;
      const off = data.find(
        (r) =>
          r.task === task.id && r.config === n.toString(2).padStart(3, "0"),
      );
      const on = data.find(
        (r) =>
          r.task === task.id &&
          r.config === (n | mask).toString(2).padStart(3, "0"),
      );
      const a = totalTokens(off),
        b = totalTokens(on);
      pairs.push({
        task: task.id,
        off: off.config,
        on: on.config,
        successDelta: Number(on.success) - Number(off.success),
        secondsDelta: (on.elapsedMs - off.elapsedMs) / 1000,
        tokensDelta: a === null || b === null ? null : b - a,
      });
    }
  return {
    factor,
    pairs,
    meanSuccessDelta: mean(pairs.map((p) => p.successDelta)),
    meanSecondsDelta: mean(pairs.map((p) => p.secondsDelta)),
    meanTokensDelta: pairs.every((p) => p.tokensDelta !== null)
      ? mean(pairs.map((p) => p.tokensDelta))
      : null,
  };
});
const summary = {
  cells,
  factors,
  failures: data
    .filter((r) => !r.success)
    .map((r) => ({
      task: r.task,
      config: r.config,
      exitCode: r.exitCode,
      error: r.error,
      checked: r.checked,
      reviewCorrect: r.reviewCorrect,
      policyUnchanged: r.policyUnchanged,
    })),
  limitations: [
    "Two development tasks; one sample per task/config; descriptive paired differences only, no significance or generalization claim.",
    "Token counts include cache reads/writes; catalog costs are not invoices.",
    "A=1 permits overlap but observed overlap is reported separately.",
    "Takeovers count attempted tool calls; inspect trace for successful declarations and justification.",
    "Native baseline is a whole-mode comparison, not a factorial cell.",
  ],
};
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
