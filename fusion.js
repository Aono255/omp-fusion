// Fusion mode for omp — lead/sidekick pairing inspired by Devin Local Fusion.
// `/fusion` installs a per-request execution policy for the lead and displays
// activity for its persistent `fusion-sidekick` agent.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import createFusionStatus from "./fusion-status.js";

const STATE_TYPE = "omp.fusion.state";
const SIDEKICK_AGENT = "fusion-sidekick";
// omp's task tool asks for CamelCase names; the returned ID may still differ
// (e.g. "Sidekick-2") when the name is taken, so the lead keeps the real ID.
const SIDEKICK_NAME = "Sidekick";

// npm-installed plugins are not scanned by omp's task-agent discovery (which
// only reads the marketplace registry), so the bundled sidekick definition is
// installed into the user agents dir on session start. A sha marker records
// the content we installed: the file is refreshed only while it still matches
// a previously installed revision, so user edits are never overwritten.
const SIDEKICK_MARKER = ".fusion-sidekick.sha256";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function agentDir() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  const home = homedir();
  for (const candidate of [join(home, ".omp", "agent"), join(home, ".pi", "agent")]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(home, ".omp", "agent");
}

function bundledSidekickPath() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "agents", "fusion-sidekick.md");
  } catch {
    return undefined;
  }
}

/** Install or refresh the sidekick agent definition; returns true if present. */
function ensureSidekickAgent() {
  const source = bundledSidekickPath();
  if (!source || !existsSync(source)) return false;
  const content = readFileSync(source, "utf8");
  const dir = join(agentDir(), "agents");
  const target = join(dir, "fusion-sidekick.md");
  const marker = join(dir, SIDEKICK_MARKER);

  if (existsSync(target)) {
    const installed = readFileSync(target, "utf8");
    if (installed === content) {
      // Already current; backfill the marker so future upgrades can tell
      // our file from a user-modified one.
      if (!existsSync(marker)) writeFileSync(marker, sha256(content));
      return true;
    }
    const markerSha = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
    // User-modified (or foreign) file: leave it alone.
    if (!markerSha || sha256(installed) !== markerSha) return true;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(target, content);
  writeFileSync(marker, sha256(content));
  return true;
}

const BRIEF_POLICY = `Give the sidekick the goal, relevant code locations, consequential design decisions, constraints, hard edge cases, and observable acceptance criteria. Let it choose routine implementation details and targeted verification commands. Supply code snippets only when an exact algorithm or interface is itself the decision. Allow grounded pushback; resolve conflicting evidence before proceeding.`;
const SCHEDULING_POLICY = `The task launch returns while the sidekick runs, and its completion report is delivered to you automatically. If you have genuinely independent lead work, do it during the handoff. Otherwise call wait; do not invent work or duplicate the sidekick's investigation. Receive the actual completion report before reviewing or answering. Later briefs go to the same worker by writing the brief as content to agent://<ID>; delivery returns immediately (a parked sidekick is revived with its history), then call wait for its report.`;
const ENFORCE_HANDOFF = true;
const CONTRACT = `<fusion_contract>
You lead a persistent pair. Own user communication, interpretation of ambiguity, consequential design, review, and authority actions. The sidekick owns delegated exploration, implementation, tests, and environment operations.

For each request:
1. Answer conversation and planning yourself. For hands-on work, inspect only enough to settle the goal and consequential choices, then dispatch a real brief. A promise or idle worker is not delegation.
2. ${BRIEF_POLICY}
3. Create agent "${SIDEKICK_AGENT}" with requested name "${SIDEKICK_NAME}" through task on its first real assignment. Retain the ID task returns (it can differ from the requested name) and reuse it, recovering it through read history:// when necessary. Do not spawn a second sidekick while one exists. Its context and runtime persist; share briefs, evidence, and feedback rather than your complete conversation. Mention existing processes when relevant so they are reused.
4. ${SCHEDULING_POLICY}
5. Review the changed code and reported evidence; do not repeat successful checks without a concrete reason to doubt them. Batch corrections into one brief. If guided corrections fail or the worker cannot solve the problem, take over and finish. Keep the user informed of results, not internal delegation ceremony.

Lead-only work includes exact shared/production queries, grading or evaluation specifications, critical data interpretation, complex interactive browser work, commits, pushes, PRs, and user replies. Author correctness-critical instructions yourself; the sidekick may mechanically execute your frozen recipe. A stronger sidekick may explore relevant code and challenge assumptions; the lead still decides.

Before direct execution for lead-only work or recovery, call fusion_control with action "takeover" and a concrete reason. This declaration lasts only for the current request. Use action "delegate" to return to delegated execution. Do not claim an exception merely because ordinary implementation is small or easy. ${ENFORCE_HANDOFF ? "The runtime blocks direct execution until takeover is declared." : "Takeover is recorded but direct execution is not blocked."}
</fusion_contract>`;

const OFF_POLICY =
  "Fusion mode is OFF. No Fusion pairing is required for this request; use the ordinary tool and delegation policies, regardless of earlier Fusion messages in the conversation.";

// `write` is both file mutation and omp's URL transport. Coordination targets
// stay open to the lead: agent:// (brief/steer the sidekick), out:// (progress
// to the user), local:// (shared brief artifacts), proc://<id>/kill (stop a
// job), and xd:// (device calls re-emit tool_call under the device's own name,
// so mutating devices such as ast_edit or lsp rename are gated there).
// Everything else — files, ssh://, cfg://, service stdin — is direct execution.
const COORDINATION_WRITE = /^(?:agent|out|local|xd):\/\/|^proc:\/\/[^/?#]+\/kill$/;

function isDirectWrite(path) {
  return typeof path !== "string" || !COORDINATION_WRITE.test(path.trim());
}

export default function fusionMode(pi) {
  let active = false;
  let takeover = false;
  let hasFusionState = false;
  let autocompleteInstalled = false;
  const status = createFusionStatus(pi, SIDEKICK_AGENT);

  function withFusionState(result) {
    if (!result || !/^\/[^\s/]*$/.test(result.prefix)) return result;
    const index = result.items.findIndex((item) => item.value === "fusion");
    if (index < 0) return result;
    const items = result.items.slice();
    items[index] = {
      ...items[index],
      description: `Fusion: ${active ? "on" : "off"}`,
    };
    return { ...result, items };
  }

  async function refreshState(ctx) {
    active = false;
    hasFusionState = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        hasFusionState = true;
        active = entry.data?.active === true;
      }
    }
    status.setActive(ctx, active);
    await syncControlTool();
  }

  async function setActive(next, ctx) {
    active = next;
    takeover = false;
    hasFusionState = true;
    pi.appendEntry(STATE_TYPE, { active: next });
    status.setActive(ctx, active);
    await syncControlTool();
    if (next) {
      ctx.ui.notify(
        `Fusion on — lead delegates to the persistent "${SIDEKICK_NAME}" sidekick (agent: ${SIDEKICK_AGENT}). /fusion again to exit.`,
        "info",
      );
    } else {
      ctx.ui.notify("Fusion off — back to normal tools.", "info");
    }
  }

  pi.registerTool({
    name: "fusion_control",
    label: "Fusion control",
    description:
      "Declare lead takeover for lead-only authority, critical analysis, browser work or recovery; return to delegated execution when done. Does not grant security permissions or stop workers.",
    defaultInactive: true,
    // Extension tools default to "discoverable", which mounts them behind
    // `write xd://`; keep the control top-level so the lead can always reach it.
    loadMode: "essential",
    approval: "read",
    parameters: pi.zod.object({
      action: pi.zod.enum(["takeover", "delegate"]),
      reason: pi.zod.string().min(1),
    }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error("Cancelled");
      if (!active) throw new Error("Fusion is not enabled");
      if (!params.reason.trim())
        throw new Error("A concrete reason is required");
      takeover = params.action === "takeover";
      const details = {
        action: params.action,
        reason: params.reason,
        takeover,
      };
      pi.appendEntry("omp.fusion.control", details);
      return {
        content: [
          {
            type: "text",
            text: takeover
              ? "Lead takeover declared for this request. Existing permissions still apply; coordinate any running worker before touching its files."
              : "Delegated execution restored.",
          },
        ],
        details,
      };
    },
  });
  pi.on("tool_call", (event) => {
    if (!active || !ENFORCE_HANDOFF || takeover) return;
    const direct =
      [
        "edit",
        "bash",
        "eval",
        "exec",
        "python",
        "apply_patch",
        "ast_edit",
        "debug",
        "ssh",
      ].includes(event.toolName) ||
      (event.toolName === "write" && isDirectWrite(event.input?.path)) ||
      (event.toolName === "lsp" &&
        ["rename", "rename_file", "code_actions", "request"].includes(
          event.input?.action,
        ));
    if (direct)
      return {
        block: true,
        reason:
          "Fusion delegates hands-on work to its persistent sidekick: brief it through task or by writing to agent://<ID>. For lead-only work or recovery, declare takeover with fusion_control first.",
      };
  });
  async function syncControlTool() {
    const names = pi.getActiveTools();
    const next = names.filter((name) => name !== "fusion_control");
    if (active) next.push("fusion_control");
    if (
      next.length !== names.length ||
      next.some((name, index) => name !== names[index])
    )
      await pi.setActiveTools(next);
  }

  pi.setLabel("Fusion");

  pi.registerCommand("fusion", {
    description:
      "Fusion lead/sidekick mode. /fusion [prompt] toggles and submits a directive; /fusion lead <model> sets the lead model for this session; /fusion status shows state.",
    handler: async (args, ctx) => {
      await refreshState(ctx);
      const text = String(args ?? "").trim();
      const [sub, ...rest] = text.split(/\s+/);

      if (sub === "lead") {
        const spec = rest.join(" ").trim();
        if (!spec) {
          const cur = ctx.models?.current?.();
          ctx.ui.notify(
            `Lead model: ${cur ? `${cur.provider}/${cur.id}` : "unknown"}. Usage: /fusion lead <model[:level]>`,
            "info",
          );
          return;
        }
        const resolved = ctx.models?.resolve?.(spec);
        if (!resolved) {
          ctx.ui.notify(`Cannot resolve model "${spec}".`, "error");
          return;
        }
        await pi.setModel(resolved);
        ctx.ui.notify(
          `Lead model set to ${resolved.provider}/${resolved.id}.`,
          "info",
        );
        return;
      }

      if (sub === "status") {
        ctx.ui.notify(
          `Fusion ${active ? "ON" : "OFF"} — ${status.describe(ctx)}. Configure the sidekick model in /agents.`,
          "info",
        );
        return;
      }

      await setActive(!active, ctx);
      if (active && text) {
        pi.sendUserMessage(text);
      }
    },
  });
  pi.on("session_start", async (_e, ctx) => {
    try {
      ensureSidekickAgent();
    } catch (error) {
      ctx.ui.notify(
        `Fusion: could not install ${SIDEKICK_AGENT} agent (${error instanceof Error ? error.message : String(error)})`,
        "warning",
      );
    }
    await refreshState(ctx);
    if (!ctx.hasUI || autocompleteInstalled) return;
    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(...args) {
        return withFusionState(await current.getSuggestions(...args));
      },
      applyCompletion: current.applyCompletion.bind(current),
      getInlineHint: current.getInlineHint?.bind(current),
      trySyncSlashCompletion: current.trySyncSlashCompletion
        ? (...args) => withFusionState(current.trySyncSlashCompletion(...args))
        : undefined,
      trySyncInlineReplace: current.trySyncInlineReplace?.bind(current),
      getForceFileSuggestions: current.getForceFileSuggestions?.bind(current),
      shouldTriggerFileCompletion:
        current.shouldTriggerFileCompletion?.bind(current),
    }));
    autocompleteInstalled = true;
  });
  pi.on("session_branch", async (_e, ctx) => {
    takeover = false;
    await refreshState(ctx);
  });
  pi.on("session_tree", async (_e, ctx) => {
    takeover = false;
    await refreshState(ctx);
  });
  pi.on("session_switch", async (_e, ctx) => {
    takeover = false;
    await refreshState(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    takeover = false;
    await syncControlTool();
    if (!hasFusionState) return;
    return {
      systemPrompt: [...event.systemPrompt, active ? CONTRACT : OFF_POLICY],
    };
  });
}
