import { describe, expect, it, mock } from "bun:test";
// pi.zod is only used to declare the tool's parameter schema; execute() receives
// already-parsed params, so a structural stub keeps the test hermetic.
const zodStub = {
  object: (shape) => ({ kind: "object", shape }),
  enum: (values) => ({ kind: "enum", values }),
  string: () => ({ min: () => ({ kind: "string" }) }),
};

// fusion-status.js pulls in @oh-my-pi/pi-tui natives that are unavailable under
// plain bun; the control logic under test never touches the status widget.
mock.module("../fusion-status.js", () => ({
  default: () => ({ setActive() {}, describe: () => "fusion status" }),
}));

const { default: fusionMode } = await import("../fusion.js");

const FUSION_ON_BRANCH = [
  { type: "custom", customType: "omp.fusion.state", data: { active: true } },
];
const FUSION_OFF_BRANCH = [
  { type: "custom", customType: "omp.fusion.state", data: { active: false } },
];

function createPi(initialTools = ["read", "write", "edit", "bash", "task", "wait"]) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  let activeTools = [...initialTools];
  const pi = {
    zod: zodStub,
    setLabel() {},
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    sendUserMessage() {},
    async setModel() {
      return true;
    },
    getActiveTools: () => [...activeTools],
    async setActiveTools(next) {
      activeTools = [...next];
    },
  };
  const emit = async (event, payload, ctx) => {
    const results = [];
    for (const handler of handlers.get(event) ?? [])
      results.push(await handler(payload, ctx));
    return results;
  };
  return {
    pi,
    commands,
    tools,
    entries,
    emit,
    getActiveTools: () => [...activeTools],
  };
}

function makeCtx(branch = []) {
  return {
    hasUI: false,
    sessionManager: { getBranch: () => branch },
    ui: { notify() {}, addAutocompleteProvider() {} },
    models: { current: () => undefined, resolve: () => undefined },
  };
}

async function startFusion(harness, branch = FUSION_ON_BRANCH) {
  await harness.emit(
    "session_start",
    { type: "session_start" },
    makeCtx(branch),
  );
}

function toolCall(harness, toolName, input = {}) {
  return harness.emit("tool_call", {
    type: "tool_call",
    toolCallId: "tc1",
    toolName,
    input,
  });
}

function control(harness, params, signal) {
  return harness.tools.get("fusion_control").execute("c1", params, signal);
}

describe("fusion_control handoff enforcement", () => {
  it("blocks direct execution while Fusion is on until takeover is declared", async () => {
    const h = createPi();
    fusionMode(h.pi);
    await startFusion(h);

    for (const name of [
      "edit",
      "write",
      "bash",
      "eval",
      "exec",
      "python",
      "apply_patch",
      "ast_edit",
      "debug",
      "ssh",
    ]) {
      const [result] = await toolCall(h, name);
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("fusion_control");
    }
    const [lspRename] = await toolCall(h, "lsp", { action: "rename" });
    expect(lspRename?.block).toBe(true);
    // `write` mutates files and remote/config/service targets...
    for (const path of [
      "src/page.ts",
      "/tmp/out.txt",
      "ssh://host/etc/app.conf",
      "cfg://task/eager",
      "proc://dev-server",
      "proc://bg_1/mode",
      "skill://x/agent://y",
    ]) {
      const [result] = await toolCall(h, "write", { path, content: "x" });
      expect(result?.block).toBe(true);
    }

    // ...but read-only, delegation, and coordination paths stay available.
    for (const [name, input] of [
      ["read", { path: "history://" }],
      ["task", { agent: "fusion-sidekick" }],
      ["write", { path: "agent://Sidekick", content: "next brief" }],
      ["write", { path: "agent://all", content: "status?" }],
      ["write", { path: "out://progress.md", content: "update" }],
      ["write", { path: "local://brief.md", content: "brief" }],
      ["write", { path: "proc://bg_1/kill" }],
      ["write", { path: "xd://lsp", content: '{"action":"hover"}' }],
      ["wait", {}],
      ["lsp", { action: "hover" }],
      ["fusion_control", { action: "takeover", reason: "x" }],
    ]) {
      const [result] = await toolCall(h, name, input);
      expect(result?.block).toBeUndefined();
    }

    const declared = await control(h, {
      action: "takeover",
      reason: "author the exact production query",
    });
    expect(declared.details).toEqual({
      action: "takeover",
      reason: "author the exact production query",
      takeover: true,
    });
    const [afterTakeover] = await toolCall(h, "edit");
    expect(afterTakeover?.block).toBeUndefined();

    const restored = await control(h, {
      action: "delegate",
      reason: "query authored",
    });
    expect(restored.details.takeover).toBe(false);
    const [afterDelegate] = await toolCall(h, "edit");
    expect(afterDelegate?.block).toBe(true);
  });

  it("resets takeover on the next request and on session navigation", async () => {
    const h = createPi();
    fusionMode(h.pi);
    await startFusion(h);
    await control(h, { action: "takeover", reason: "lead-only analysis" });

    // New request: before_agent_start resets the declaration.
    await h.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: [],
    });
    const [blockedAgain] = await toolCall(h, "bash");
    expect(blockedAgain?.block).toBe(true);

    // Session navigation also resets it.
    await control(h, { action: "takeover", reason: "recovery" });
    await h.emit(
      "session_switch",
      { type: "session_switch" },
      makeCtx(FUSION_ON_BRANCH),
    );
    const [afterSwitch] = await toolCall(h, "bash");
    expect(afterSwitch?.block).toBe(true);
  });

  it("passes through and rejects control calls while Fusion is off", async () => {
    const h = createPi();
    fusionMode(h.pi);
    await startFusion(h, FUSION_OFF_BRANCH);

    const [result] = await toolCall(h, "edit");
    expect(result?.block).toBeUndefined();
    await expect(
      control(h, { action: "takeover", reason: "x" }),
    ).rejects.toThrow("Fusion is not enabled");
  });

  it("activates fusion_control only while on and preserves unrelated tools", async () => {
    const h = createPi(["read", "edit", "task", "wait"]);
    fusionMode(h.pi);
    await startFusion(h);
    expect(h.getActiveTools()).toEqual([
      "read",
      "edit",
      "task",
      "wait",
      "fusion_control",
    ]);

    // Toggling off restores the original set exactly.
    await h.commands.get("fusion").handler("", makeCtx(FUSION_ON_BRANCH));
    expect(h.getActiveTools()).toEqual(["read", "edit", "task", "wait"]);
  });

  it("rejects blank reasons and aborted calls without changing state", async () => {
    const h = createPi();
    fusionMode(h.pi);
    await startFusion(h);

    await expect(
      control(h, { action: "takeover", reason: "   " }),
    ).rejects.toThrow("concrete reason");
    await expect(
      control(h, { action: "takeover", reason: "x" }, { aborted: true }),
    ).rejects.toThrow("Cancelled");
    const [stillBlocked] = await toolCall(h, "edit");
    expect(stillBlocked?.block).toBe(true);
    expect(
      h.entries.filter((e) => e.type === "omp.fusion.control"),
    ).toHaveLength(0);
  });

  it("appends the contract only with Fusion state and records control entries", async () => {
    const h = createPi();
    fusionMode(h.pi);
    await startFusion(h);

    const [onResult] = await h.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: ["base"],
    });
    expect(onResult.systemPrompt.at(-1)).toContain("<fusion_contract>");
    expect(onResult.systemPrompt.at(-1)).toContain(
      "runtime blocks direct execution",
    );

    await control(h, {
      action: "takeover",
      reason: "commit the reviewed diff",
    });
    expect(h.entries.at(-1)).toEqual({
      type: "omp.fusion.control",
      data: {
        action: "takeover",
        reason: "commit the reviewed diff",
        takeover: true,
      },
    });

    await h.emit(
      "session_switch",
      { type: "session_switch" },
      makeCtx(FUSION_OFF_BRANCH),
    );
    const [offResult] = await h.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: ["base"],
    });
    expect(offResult.systemPrompt.at(-1)).toContain("Fusion mode is OFF");

    // No Fusion state at all: no prompt mutation.
    await h.emit("session_switch", { type: "session_switch" }, makeCtx([]));
    const [bare] = await h.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: ["base"],
    });
    expect(bare).toBeUndefined();
  });
});
