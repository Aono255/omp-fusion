import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Opt-in integration smoke: uses the installed OMP CLI and the user's model credentials.
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "omp-fusion-delegation-"));
const prompts = [
  "Implement normalizeName in normalize.mjs: trim surrounding whitespace and lowercase strings; return null for an all-whitespace string. Change only normalize.mjs. Verify the behavior by running Node on '  ALIce  ' and '   '. Do not run formatters, lint, builds, other test suites, or commit changes.",
  "Continue improving normalizeName: reject every non-string input with TypeError, including objects with a trim method. Preserve the string behavior. Use Node to verify rejection of {trim: () => 'alice'} and that '  ALIce  ' still becomes 'alice'. Do not run formatters, lint, builds, other test suites, or commit changes.",
  "Add an exported isBlank(value) function to normalize.mjs: return true for an all-whitespace string and false for a string containing non-whitespace. Preserve normalizeName. Verify both outcomes with Node. Do not run formatters, lint, builds, other test suites, or commit changes.",
  "Explain the difference between trimming whitespace and lowercasing a string in one sentence.",
];
// `write` is also omp's URL transport; only file and other non-coordination
// targets count as the lead executing work itself.
const coordinationWrite = /^(?:agent|out|local|xd):\/\/|^proc:\/\/[^/?#]+\/kill$/;
function isDirectExecution(call) {
  if (call.name === "write")
    return !coordinationWrite.test(String(call.arguments?.path ?? ""));
  return ["edit", "bash", "eval"].includes(call.name);
}
function briefsWorker(call, id) {
  const path = String(call.arguments?.path ?? "");
  return (
    call.name === "write" &&
    (path === `agent://${id}` || path.startsWith(`agent://${id}?`))
  );
}
function briefsAnyWorker(call) {
  return (
    call.name === "write" &&
    /^agent:\/\//.test(String(call.arguments?.path ?? ""))
  );
}

try {
  writeFileSync(
    join(cwd, "normalize.mjs"),
    "export function normalizeName(value) { return value; }\n",
  );
  const run = spawnSync(
    "omp",
    [
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-title",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-extensions",
      "--wait-async",
      "--extension",
      pluginRoot,
      ...process.argv.slice(2),
      "--max-time",
      "300",
      "/fusion",
      prompts[3],
      prompts[0],
      prompts[1],
      "/fusion",
      prompts[2],
    ],
    { cwd, encoding: "utf8", timeout: 330_000, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || "OMP did not finish successfully");

  const calls = prompts.map(() => []);
  const workerById = new Map();
  const completedJobs = new Set();
  const replies = prompts.map(() => false);
  const leadModels = new Set();
  function collect(details) {
    for (const entry of [
      ...(details?.results ?? []),
      ...(details?.progress ?? []),
    ]) {
      if (!entry?.id) continue;
      const merged = { ...(workerById.get(entry.id) ?? {}) };
      for (const [key, value] of Object.entries(entry))
        if (value !== undefined) merged[key] = value;
      workerById.set(entry.id, merged);
    }
    for (const job of details?.jobs ?? []) {
      if (job.status === "completed") completedJobs.add(job.id);
      if (job.status === "failed" && workerById.has(job.id))
        workerById.get(job.id).error = job.error ?? "Worker job failed";
    }
  }
  let stage = -1;
  for (const line of run.stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "tool_execution_update" && event.toolName === "task")
      collect(event.partialResult?.details);
    if (event.type === "tool_execution_end" && event.toolName === "task")
      collect(event.result?.details);
    if (event.type !== "message_end") continue;
    const message = event.message;
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const index = prompts.indexOf(text);
      if (index >= 0) stage = index;
    }
    if (stage < 0) continue;
    if (message.role === "assistant") {
      leadModels.add(`${message.provider}/${message.model}`);
      calls[stage].push(...content.filter((part) => part.type === "toolCall"));
      if (content.some((part) => part.type === "text" && part.text.trim()))
        replies[stage] = true;
    }
    if (message.role === "custom" && message.customType === "async-result")
      collect(message.details);
    if (message.role === "toolResult" && message.toolName === "task")
      collect(message.details);
  }
  assert.ok(replies[3], "The lead must answer the conversational request");
  assert.ok(
    !calls[3].some((call) => call.name === "task" || briefsAnyWorker(call)),
    "Conversation must not start or brief a worker",
  );

  const workers = [...workerById.values()].filter(
    (worker) => worker.agent === "fusion-sidekick",
  );
  assert.equal(
    workers.length,
    1,
    `Ordinary Fusion work must create one real sidekick, not edit inline or spawn again:\n${JSON.stringify({ leadModels: [...leadModels], calls: calls.map((items) => items.map((call) => ({ tool: call.name, path: call.arguments.path }))), workers: workers.map(({ id, exitCode, status, error }) => ({ id, exitCode, status, error })), stderr: run.stderr }, null, 2)}`,
  );
  const worker = workers[0];
  const workerFinished =
    (worker.exitCode === 0 ||
      worker.status === "completed" ||
      completedJobs.has(worker.id)) &&
    !worker.aborted &&
    worker.error === undefined;
  assert.ok(
    workerFinished,
    `The sidekick's implementation must complete successfully:\n${JSON.stringify({ worker: { id: worker.id, exitCode: worker.exitCode, status: worker.status, error: worker.error, aborted: worker.aborted }, completedJobs: [...completedJobs] }, null, 2)}`,
  );
  assert.ok(
    calls[0].some((call) => call.name === "task"),
    "First assignment must dispatch the sidekick",
  );
  assert.ok(
    calls[1].some((call) => briefsWorker(call, workers[0].id)),
    "Follow-up work must reuse the actual sidekick ID",
  );
  for (let index = 0; index < 2; index += 1) {
    assert.ok(
      !calls[index].some(isDirectExecution),
      "The lead performed ordinary implementation or execution while Fusion was enabled",
    );
  }
  assert.ok(
    calls[2].some(isDirectExecution),
    "Disabling Fusion must restore normal inline work",
  );
  assert.ok(
    !calls[2].some((call) => briefsWorker(call, workers[0].id)),
    "Disabled Fusion kept routing work to the old sidekick",
  );

  const { normalizeName, isBlank } = await import(
    pathToFileURL(join(cwd, "normalize.mjs")).href
  );
  assert.equal(normalizeName("  ALIce  "), "alice");
  assert.equal(normalizeName("   "), null);
  assert.throws(() => normalizeName({ trim: () => "alice" }), TypeError);
  assert.equal(isBlank(" \t "), true);
  assert.equal(isBlank(" a "), false);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        leadModels: [...leadModels],
        sidekick: workers[0].id,
        model: workers[0].resolvedModelIdentity ?? workers[0].resolvedModel,
        calls: calls.map((stageCalls) => stageCalls.map((call) => call.name)),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
