import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const leadModel =
  process.env.FUSION_ABLATION_LEAD_MODEL ?? "opencodex/gpt-6-astra--fast";
const sidekickModel =
  process.env.FUSION_ABLATION_SIDEKICK_MODEL ?? "devin/swe-2:high";
const leadThinking = process.env.FUSION_ABLATION_LEAD_THINKING ?? "high";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const selectedConfigIds = new Set(
  (
    process.env.FUSION_ABLATION_CONFIGS ??
    "native,000,001,010,011,100,101,110,111"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const maxSeconds = Number(process.env.FUSION_ABLATION_MAX_SECONDS ?? "180");
const settingsText = `modelRoles:\n  smol: ${sidekickModel}\ntask:\n  agentModelOverrides:\n    fusion-sidekick: ${sidekickModel}\nasync:\n  enabled: true\nadvisor:\n  enabled: false\nprewalk:\n  enabled: false\nmemories:\n  enabled: false\n`;
const policy =
  'export function canExport(user) { return user.role === "admin" || user.active; }\n';
const review =
  " Also independently inspect policy.mjs and end your final response with EXPORT_LEAK=true if an active non-admin can export, otherwise EXPORT_LEAK=false. Do not modify policy.mjs.";
const constraints =
  " Change only the requested implementation file. Verify with Node. Do not run formatters, linters, unrelated suites or commits.";
const tasks = [
  {
    id: "intervals",
    file: "intervals.mjs",
    symbol: "mergeIntervals",
    source:
      'export function mergeIntervals(items) { throw new Error("Not implemented"); }\n',
    prompt:
      "Implement mergeIntervals(items) in intervals.mjs. Input must be an array of finite [start,end] number pairs with start <= end; reject malformed input with TypeError. Return a fresh array sorted by start then end, merging overlapping or touching intervals; never mutate input or retain input pair references. Empty input returns []. Example: [[5,7],[1,3],[3,4],[8,8]] returns [[1,4],[5,7],[8,8]]." +
      constraints +
      review,
    checks: `const a = Object.freeze([Object.freeze([5,7]),Object.freeze([1,3]),Object.freeze([3,4]),Object.freeze([8,8])]);
assert.deepEqual(fn(a), [[1,4],[5,7],[8,8]]);
assert.deepEqual(fn([[2,3],[0,10],[2,2],[-4,-1],[-1,0]]), [[-4,10]]);
assert.deepEqual(fn([]), []);
const single = [[1,2]]; const out = fn(single); out[0][0] = 99; assert.equal(single[0][0], 1);
for (const invalid of [null, {}, [[2,1]], [[1,Infinity]], [[1,NaN]], [["1",2]], [[1]], [[1,2,3]], [null]]) assert.throws(() => fn(invalid), TypeError);`,
  },
  {
    id: "page",
    file: "page.mjs",
    symbol: "selectPage",
    source:
      'export function selectPage(items, query, offset, limit) { throw new Error("Not implemented"); }\n',
    prompt:
      "Implement selectPage(items, query, offset, limit) in page.mjs. Items are records with unique ASCII string id, string name and finite numeric score. Match name containing query case-insensitively, sort matches by score descending then ASCII id ascending, apply zero-based offset/limit, and return {items,total} with total BEFORE pagination. Do not mutate input. Empty query matches all. Offset beyond matches returns items=[] with the full filtered total. Reject non-string query, non-integer/negative offset and non-integer/non-positive limit with TypeError." +
      constraints +
      review,
    checks: `const a = Object.freeze([{id:'b',name:'Alpha',score:2},{id:'a',name:'alpha',score:2},{id:'z',name:'ALPINE',score:9},{id:'c',name:'Beta',score:1}].map(Object.freeze));
assert.deepEqual(fn(a,'ALP',1,1), {items:[a[1]],total:3});
assert.deepEqual(fn(a,'alp',2,2), {items:[a[0]],total:3});
assert.deepEqual(fn(a,'alp',9,2), {items:[],total:3});
assert.deepEqual(fn(a,'none',0,2), {items:[],total:0});
assert.deepEqual(fn(a,'',0,8), {items:[a[2],a[1],a[0],a[3]],total:4});
for (const args of [[null,0,1],['',-1,1],['',0.5,1],['',0,0],['',0,1.5],['',NaN,1]]) assert.throws(() => fn(a,...args), TypeError);`,
  },
];
const selectedTaskIds = new Set(
  (process.env.FUSION_ABLATION_TASKS ?? "intervals,page")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedTasks = tasks.filter((task) => selectedTaskIds.has(task.id));
const configs = [
  { id: "native", brief: false, async: false, gate: false },
  ...Array.from({ length: 8 }, (_, n) => ({
    id: n.toString(2).padStart(3, "0"),
    brief: Boolean(n & 4),
    async: Boolean(n & 2),
    gate: Boolean(n & 1),
  })),
];
function shuffled(items, seed) {
  const result = [...items];
  let x = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const j = (x >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function replaceOne(text, regex, replacement) {
  const hits = [...text.matchAll(new RegExp(regex.source, "g"))];
  if (hits.length !== 1)
    throw new Error(
      `Expected one experiment seam ${regex}, found ${hits.length}`,
    );
  return text.replace(regex, () => replacement);
}
function variant(source, agent, config) {
  if (!config.brief)
    source = replaceOne(
      source,
      /const BRIEF_POLICY = `[\s\S]*?`;/,
      "const BRIEF_POLICY = `Specify code, not only intent: give exact file locations and replacement snippets, verification commands verbatim, and their expected results. Settle routine implementation choices before dispatch. The worker implements this complete recipe.`;",
    );
  if (!config.async)
    source = replaceOne(
      source,
      /const SCHEDULING_POLICY = `[\s\S]*?`;/,
      "const SCHEDULING_POLICY = `The initial task launch blocks until the worker reports. Wait for its actual report before continuing. Later briefs reuse the same worker through hub send with await: true. Do not duplicate the worker investigation or invent reports.`;",
    );
  source = replaceOne(
    source,
    /const ENFORCE_HANDOFF = (true|false);/,
    `const ENFORCE_HANDOFF = ${config.gate};`,
  );
  agent = agent.replace(/^blocking:.*\n/m, "");
  if (!config.async)
    agent = agent.replace(
      'model: "@smol"\n',
      'model: "@smol"\nblocking: true\n',
    );
  return { source, agent };
}
const observerCode = `import {appendFileSync} from 'node:fs';
export default function observe(pi) {
  let owner; const parentCalls = new Set(); const children = new Set();
  const emit = (kind,data) => appendFileSync(process.env.FUSION_ABLATION_TRACE, JSON.stringify({at:Date.now(),owner,kind,...data})+'\\n');
  pi.on('session_start', (_e,ctx) => { owner=ctx.sessionManager.getSessionId(); emit('session',{}); });
  pi.on('message_end', e => { if(e.message.role==='assistant') emit('message',{role:'lead',message:e.message}); });
  pi.on('tool_execution_start', e => {parentCalls.add(e.toolCallId);emit('tool_start',{role:'lead',event:e});});
  pi.on('tool_execution_end', e => emit('tool_end',{role:'lead',event:e}));
  pi.on('tool_call', e => emit('attempt',{role:'lead',event:e}));
  const off=[
    pi.events.on('task:subagent:lifecycle', e => {if(e.parentToolCallId && parentCalls.has(e.parentToolCallId)) children.add(e.id);if(children.has(e.id))emit('worker_lifecycle',{event:e});}),
    pi.events.on('task:subagent:event', e => {if(children.has(e.id) && ['message_end','agent_start','agent_end','tool_execution_start','tool_execution_end'].includes(e.event.type))emit('worker_event',{id:e.id,event:e.event});})
  ];
  pi.on('session_shutdown',()=>off.forEach(f=>f()));
}`;
function parseLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function usageSummary(messages) {
  if (!messages.length)
    return {
      messages: 0,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      cost: null,
      models: [],
    };
  const result = {
    messages: messages.length,
    models: [...new Set(messages.map((m) => m.provider + "/" + m.model))],
  };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"])
    result[key] = messages.every((m) => Number.isFinite(m.usage?.[key]))
      ? messages.reduce((s, m) => s + m.usage[key], 0)
      : null;
  result.cost = messages.every((m) => Number.isFinite(m.usage?.cost?.total))
    ? messages.reduce((s, m) => s + m.usage.cost.total, 0)
    : null;
  return result;
}
function summarize(stdout, rows) {
  const owner = rows.find((r) => r.kind === "session")?.owner;
  rows = rows.filter((r) => r.owner === owner);
  const lead = rows.filter((r) => r.kind === "message").map((r) => r.message);
  const worker = rows
    .filter(
      (r) =>
        r.kind === "worker_event" &&
        r.event.type === "message_end" &&
        r.event.message?.role === "assistant",
    )
    .map((r) => r.event.message);
  const fallback = parseLines(stdout)
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => e.message);
  const finalMessages = lead.length ? lead : fallback;
  const lastText =
    [...finalMessages]
      .reverse()
      .map((m) =>
        (m.content ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      )
      .find((t) => t.trim()) ?? "";
  const toolCalls = finalMessages.flatMap((m) =>
    (m.content ?? []).filter((p) => p.type === "toolCall"),
  );
  const spans = new Map();
  const windows = [];
  for (const row of rows) {
    if (row.kind === "worker_event" && row.event.type === "agent_start")
      spans.set(row.id, row.at);
    if (
      row.kind === "worker_event" &&
      row.event.type === "agent_end" &&
      spans.has(row.id)
    ) {
      windows.push([spans.get(row.id), row.at]);
      spans.delete(row.id);
    }
  }
  const overlap = rows.filter(
    (r) =>
      r.kind === "tool_start" &&
      !["hub", "task", "fusion_control", "todo"].includes(r.event.toolName) &&
      windows.some(([s, e]) => r.at >= s && r.at <= e),
  );
  const blocks = rows.filter(
    (r) =>
      r.kind === "tool_end" &&
      JSON.stringify(r.event).includes("Fusion delegates hands-on work"),
  );
  return {
    observerPresent: Boolean(owner),
    lead: usageSummary(lead.length ? lead : fallback),
    worker: usageSummary(worker),
    reviewCorrect:
      lastText.match(/EXPORT_LEAK=(true|false)/g)?.at(-1) ===
      "EXPORT_LEAK=true",
    finalText: lastText,
    calls: toolCalls.map((c) => ({
      tool: c.name,
      op: c.arguments?.op,
      action: c.arguments?.action,
      to: c.arguments?.to,
    })),
    takeovers: toolCalls
      .filter(
        (c) =>
          c.name === "fusion_control" && c.arguments?.action === "takeover",
      )
      .map((c) => c.arguments.reason),
    blockedExecutions: blocks.length,
    workerIds: [
      ...new Set(
        rows
          .filter((r) => r.kind === "worker_lifecycle")
          .map((r) => r.event.id),
      ),
    ],
    overlappingLeadTools: overlap.map((r) => r.event.toolName),
    workerWindows: windows,
  };
}
function verify(task, cwd) {
  const script = `import assert from 'node:assert/strict'; import {${task.symbol} as fn} from ${JSON.stringify(join(cwd, task.file))};\n${task.checks}\nconsole.log('PASS');`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd, encoding: "utf8", timeout: 10000 },
  );
  return {
    passed: result.status === 0,
    error: result.stderr ?? "",
    exitCode: result.status,
  };
}
function sqliteBackup(destination) {
  const script =
    "import sqlite3,sys\ns=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nd=sqlite3.connect(sys.argv[2])\ns.backup(d)\nd.close()\ns.close()";
  const result = spawnSync(
    "python3",
    ["-c", script, join(process.env.HOME, ".omp/agent/agent.db"), destination],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error("Private credential backup failed: " + result.stderr);
}
function runCell(runRoot, source, agentSource, config, task, order) {
  const evidence = join(
    runRoot,
    `${String(order).padStart(2, "0")}-${task.id}-${config.id}`,
  );
  mkdirSync(evidence, { mode: 0o700 });
  const temp = mkdtempSync("/tmp/fusion-cell-");
  const cwd = join(temp, "work");
  const agentDir = join(temp, "agent");
  const copy = join(temp, "plugin");
  for (const dir of [cwd, agentDir, copy, join(copy, "agents")])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    symlinkSync(
      join(process.env.HOME, ".omp/agent/models.yml"),
      join(agentDir, "models.yml"),
    );
    sqliteBackup(join(agentDir, "agent.db"));
    writeFileSync(join(agentDir, "config.yml"), settingsText);
    const v = variant(source, agentSource, config);
    writeFileSync(join(copy, "fusion.js"), v.source);
    writeFileSync(join(copy, "agents/fusion-sidekick.md"), v.agent);
    copyFileSync(
      join(pluginRoot, "fusion-status.js"),
      join(copy, "fusion-status.js"),
    );
    writeFileSync(
      join(copy, "package.json"),
      JSON.stringify({
        name: "fusion-experiment",
        omp: { extensions: ["./fusion.js"] },
      }),
    );
    writeFileSync(join(temp, "observe.js"), observerCode);
    writeFileSync(join(cwd, task.file), task.source);
    writeFileSync(join(cwd, "policy.mjs"), policy);
    const trace = join(evidence, "trace.ndjson");
    writeFileSync(trace, "");
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      FUSION_ABLATION_TRACE: trace,
    };
    for (const key of [
      "PI_CONFIG_FILES",
      "OMP_CONFIG_FILES",
      "PI_BLOCKED_AGENT",
      "PI_TASK_DEPTH",
      "OMP_TASK_DEPTH",
    ])
      delete env[key];
    const args = [
      "-p",
      "--mode",
      "json",
      "--session-dir",
      join(temp, "sessions"),
      "--no-title",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-prewalk",
      "--no-extensions",
      "--extension",
      join(temp, "observe.js"),
      "--extension",
      copy,
      "--model",
      leadModel,
      "--thinking",
      leadThinking,
      "--max-time",
      String(maxSeconds),
      ...(config.id === "native" ? [] : ["/fusion"]),
      task.prompt,
    ];
    writeFileSync(
      join(evidence, "input.json"),
      JSON.stringify(
        {
          config,
          task: task.id,
          prompt: task.prompt,
          args,
          settings: settingsText,
          sourceHash: hash(v.source),
          agentHash: hash(v.agent),
        },
        null,
        2,
      ),
    );
    const started = Date.now();
    const run = spawnSync("omp", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: (maxSeconds + 30) * 1000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsedMs = Date.now() - started;
    writeFileSync(join(evidence, "stdout.ndjson"), run.stdout ?? "");
    writeFileSync(join(evidence, "stderr.txt"), run.stderr ?? "");
    const checked = verify(task, cwd);
    const measured = summarize(
      run.stdout ?? "",
      parseLines(readFileSync(trace, "utf8")),
    );
    const policyUnchanged =
      readFileSync(join(cwd, "policy.mjs"), "utf8") === policy;
    copyFileSync(join(cwd, task.file), join(evidence, task.file));
    const record = {
      order,
      config: config.id,
      task: task.id,
      started: new Date(started).toISOString(),
      elapsedMs,
      exitCode: run.status,
      signal: run.signal,
      error: run.error?.message ?? null,
      checked,
      policyUnchanged,
      ...measured,
    };
    record.modelConformant =
      measured.lead.models.length > 0 &&
      measured.lead.models.every((m) => m === leadModel) &&
      (config.id === "native" ||
        measured.worker.models.every((m) => m === "devin/swe-2"));
    record.success =
      run.status === 0 &&
      checked.passed &&
      policyUnchanged &&
      measured.reviewCorrect;
    writeFileSync(
      join(evidence, "result.json"),
      JSON.stringify(record, null, 2),
    );
    return record;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function selfCheck() {
  const temp = mkdtempSync("/tmp/fusion-verifier-");
  try {
    for (const task of tasks) {
      writeFileSync(join(temp, task.file), task.source);
      if (verify(task, temp).passed)
        throw new Error("Broken fixture incorrectly passes " + task.id);
    }
    writeFileSync(
      join(temp, "intervals.mjs"),
      `export function mergeIntervals(xs){if(!Array.isArray(xs)||xs.some(x=>!Array.isArray(x)||x.length!==2||!x.every(Number.isFinite)||x[0]>x[1]))throw new TypeError();const out=[];for(const [a,b] of xs.map(x=>[...x]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])){const last=out.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;}`,
    );
    writeFileSync(
      join(temp, "page.mjs"),
      `export function selectPage(xs,q,o,l){if(typeof q!=='string'||!Number.isInteger(o)||o<0||!Number.isInteger(l)||l<=0)throw new TypeError();const a=xs.filter(x=>x.name.toLowerCase().includes(q.toLowerCase())).sort((a,b)=>b.score-a.score||(a.id<b.id?-1:a.id>b.id?1:0));return {items:a.slice(o,o+l),total:a.length};}`,
    );
    for (const task of tasks) {
      const r = verify(task, temp);
      if (!r.passed) throw new Error(r.error);
    }
    const message = {
      provider: "p",
      model: "m",
      role: "assistant",
      content: [{ type: "text", text: "EXPORT_LEAK=true" }],
      usage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 0,
        cost: { total: 0.1 },
      },
    };
    const measured = summarize("", [
      { owner: "main", kind: "session", at: 0 },
      { owner: "main", kind: "message", at: 1, message },
      { owner: "child", kind: "message", at: 2, message },
      {
        owner: "main",
        kind: "worker_event",
        id: "w",
        at: 3,
        event: { type: "agent_start" },
      },
      { owner: "main", kind: "tool_start", at: 4, event: { toolName: "read" } },
      {
        owner: "main",
        kind: "worker_event",
        id: "w",
        at: 5,
        event: { type: "message_end", message },
      },
      {
        owner: "main",
        kind: "worker_event",
        id: "w",
        at: 6,
        event: { type: "agent_end" },
      },
    ]);
    if (
      measured.lead.messages !== 1 ||
      measured.worker.messages !== 1 ||
      measured.lead.input !== 10 ||
      measured.worker.input !== 10 ||
      measured.overlappingLeadTools.join() !== "read" ||
      !measured.reviewCorrect
    )
      throw new Error("Measurement self-check failed");
    console.log(
      "Verifier self-check: both broken fixtures fail; both reference implementations pass.",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
selfCheck();
if (!process.argv.includes("--run")) process.exit(0);
const source = readFileSync(join(pluginRoot, "fusion.js"), "utf8");
const agent = readFileSync(
  join(pluginRoot, "agents/fusion-sidekick.md"),
  "utf8",
);
for (const config of configs) variant(source, agent, config);
const outputFlag = process.argv.indexOf("--output");
const runRoot =
  outputFlag >= 0
    ? resolve(process.argv[outputFlag + 1])
    : mkdtempSync("/tmp/fusion-ablation-results-");
mkdirSync(runRoot, { recursive: true, mode: 0o700 });
if (existsSync(join(runRoot, "manifest.json")))
  throw new Error("Refusing to overwrite an existing experiment");
const manifest = {
  seed: 20260916,
  lead: `${leadModel}:${leadThinking}`,
  sidekick: sidekickModel,
  maxSeconds,
  runnerHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  sourceHash: hash(source),
  agentHash: hash(agent),
  statusHash: hash(readFileSync(join(pluginRoot, "fusion-status.js"))),
  cli: spawnSync("omp", ["--version"], { encoding: "utf8" }).stdout,
  settings: settingsText,
  tasks: selectedTasks,
  configs,
};
writeFileSync(
  join(runRoot, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
const records = [];
for (const [block, task] of selectedTasks.entries())
  for (const config of shuffled(
    configs.filter((item) => selectedConfigIds.has(item.id)),
    20260916 + block,
  )) {
    console.log(
      `RUN ${records.length + 1}/${selectedTasks.length * selectedConfigIds.size} ${task.id} ${config.id}`,
    );
    const record = runCell(
      runRoot,
      source,
      agent,
      config,
      task,
      records.length,
    );
    records.push(record);
    writeFileSync(
      join(runRoot, "results.json"),
      JSON.stringify(records, null, 2),
    );
    console.log(
      JSON.stringify({
        config: record.config,
        task: record.task,
        success: record.success,
        seconds: record.elapsedMs / 1000,
        lead: record.lead,
        worker: record.worker,
        overlap: record.overlappingLeadTools,
        takeovers: record.takeovers.length,
      }),
    );
  }
console.log("RESULTS " + runRoot);
