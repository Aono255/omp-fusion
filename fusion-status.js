import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

const WIDGET_KEY = "omp.fusion.activity";

function actor(phase = "idle") {
  return {
    id: undefined,
    model: "",
    phase,
    streaming: false,
    tools: new Map(),
  };
}

function modelIdentity(model) {
  return model?.provider && model?.id ? `${model.provider}/${model.id}` : "";
}

function settle(state, phase) {
  state.phase = phase;
  state.streaming = false;
  state.tools.clear();
}

function applyEvent(state, event) {
  switch (event.type) {
    case "agent_start":
      settle(state, "working");
      break;
    case "turn_start":
      state.phase = "working";
      break;
    case "message_start":
    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") return false;
      if (message.provider && message.model)
        state.model = `${message.provider}/${message.model}`;
      state.streaming = event.type === "message_start";
      if (state.streaming) {
        state.phase = "working";
      } else if (
        message.stopReason === "aborted" ||
        message.stopReason === "error"
      ) {
        settle(state, message.stopReason === "aborted" ? "cancelled" : "error");
      } else {
        // Execution events own the tool set; streaming may finish after a tool does.
        state.phase =
          state.tools.size ||
          message.content.some((part) => part.type === "toolCall")
            ? "waiting"
            : "idle";
      }
      break;
    }
    case "tool_execution_start":
      state.tools.set(event.toolCallId, event.toolName);
      if (!state.streaming) state.phase = "waiting";
      break;
    case "tool_execution_end":
      state.tools.delete(event.toolCallId);
      break;
    case "auto_retry_start":
      settle(state, "retrying");
      break;
    case "auto_retry_end":
      state.phase = "waiting";
      break;
    case "auto_compaction_start":
      settle(state, "compacting");
      break;
    case "auto_compaction_end":
      state.phase = "waiting";
      break;
    case "model_changed": {
      const model = modelIdentity(event.model);
      if (!model || model === state.model) return false;
      state.model = model;
      break;
    }
    case "agent_end":
      settle(
        state,
        state.phase === "error" || state.phase === "cancelled"
          ? state.phase
          : "idle",
      );
      break;
    default:
      return false;
  }
  return true;
}

function phaseLabel(state) {
  if (state.phase === "working") return "working";
  if (state.tools.size) {
    const first = state.tools.values().next().value;
    return `tool: ${first}${state.tools.size > 1 ? ` +${state.tools.size - 1}` : ""}`;
  }
  return state.phase;
}

function safeText(text) {
  return Bun.stripANSI(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function renderActor(label, state, model, width, theme) {
  const phase = safeText(phaseLabel(state));
  const name = safeText(model.slice(model.indexOf("/") + 1));
  const suffix = ` ${phase}`;
  const title = truncateToWidth(
    `${label}${name ? ` ${name}` : ""}`,
    Math.max(0, width - visibleWidth(suffix)),
  );
  const color = state.phase === "working" ? "accent" : "muted";
  const statusColor =
    state.phase === "error"
      ? "error"
      : state.tools.size || state.phase === "retrying"
        ? "warning"
        : color;
  const text = theme.fg(color, title) + theme.fg(statusColor, suffix);
  return truncateToWidth(
    state.phase === "working" ? theme.bold(text) : text,
    width,
  );
}

export default function createFusionStatus(pi, sidekickAgent) {
  let lead = actor();
  let sidekick = actor("not started");
  let context;
  let enabled = false;
  let mounted = false;
  let tui;
  const parentTools = new Set();

  function repaint() {
    if (enabled) tui?.requestRender();
  }

  function leadModel() {
    return lead.phase === "idle" ||
      lead.phase === "error" ||
      lead.phase === "cancelled"
      ? modelIdentity(context?.models.current())
      : lead.model;
  }

  function setActive(ctx, next) {
    context = ctx;
    enabled = next;
    if (!next) {
      if (mounted) ctx.ui.setWidget(WIDGET_KEY, undefined);
      mounted = false;
      tui = undefined;
      return;
    }
    if (!mounted && ctx.hasUI) {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (terminal) => {
          tui = terminal;
          let previous;
          let lines = [];
          return {
            render(width) {
              const theme = context.ui.theme;
              const available = Math.max(0, width - 10);
              const leadWidth = Math.floor(available / 2);
              const left = renderActor(
                "Lead",
                lead,
                leadModel(),
                leadWidth,
                theme,
              );
              const right = renderActor(
                "Sidekick",
                sidekick,
                sidekick.model,
                available - leadWidth,
                theme,
              );
              const line = truncateToWidth(
                theme.fg("accent", "Fusion ") +
                  left +
                  " ".repeat(Math.max(0, leadWidth - visibleWidth(left))) +
                  theme.fg("dim", " | ") +
                  right,
                width,
              );
              if (line !== previous) {
                previous = line;
                lines = [line];
              }
              return lines;
            },
            invalidate() {
              previous = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      mounted = true;
    }
    repaint();
  }

  function reset(_event, ctx) {
    if (mounted) ctx.ui.setWidget(WIDGET_KEY, undefined);
    mounted = false;
    tui = undefined;
    context = ctx;
    lead = actor();
    sidekick = actor("not started");
    parentTools.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type === "toolCall") parentTools.add(part.id);
        }
      }
      if (message.role !== "toolResult") continue;
      for (const result of message.details?.results ?? []) {
        if (result.agent !== sidekickAgent) continue;
        sidekick.id = result.id;
        sidekick.model = result.resolvedModelIdentity ?? "";
        sidekick.phase = result.aborted
          ? "cancelled"
          : result.exitCode === 0
            ? "idle"
            : "error";
      }
    }
    setActive(ctx, enabled);
  }

  function onLeadEvent(event, ctx) {
    context = ctx;
    if (event.type === "agent_start" || event.type === "turn_start")
      lead.model = modelIdentity(ctx.models.current());
    if (event.type === "tool_execution_start")
      parentTools.add(event.toolCallId);
    if (applyEvent(lead, event)) repaint();
  }

  for (const event of [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "agent_end",
    "auto_retry_start",
    "auto_retry_end",
    "auto_compaction_start",
    "auto_compaction_end",
  ]) {
    pi.on(event, onLeadEvent);
  }
  for (const event of [
    "session_start",
    "session_switch",
    "session_branch",
    "session_tree",
  ])
    pi.on(event, reset);

  const unsubscribers = [
    pi.events.on("task:subagent:lifecycle", (payload) => {
      if (payload.agent !== sidekickAgent) return;
      if (
        payload.parentToolCallId &&
        !parentTools.has(payload.parentToolCallId)
      )
        return;
      if (payload.status === "started") {
        sidekick = actor("starting");
        sidekick.id = payload.id;
      } else if (payload.id === sidekick.id) {
        settle(
          sidekick,
          payload.status === "aborted"
            ? "cancelled"
            : payload.status === "failed"
              ? "error"
              : "idle",
        );
      } else {
        return;
      }
      repaint();
    }),
    pi.events.on("task:subagent:progress", (payload) => {
      if (payload.agent !== sidekickAgent) return;
      const progress = payload.progress;
      if (progress.id !== sidekick.id) return;
      if (
        progress.resolvedModelIdentity &&
        progress.resolvedModelIdentity !== sidekick.model
      ) {
        sidekick.model = progress.resolvedModelIdentity;
        repaint();
      }
    }),
    pi.events.on("task:subagent:event", (payload) => {
      if (payload.id === sidekick.id && applyEvent(sidekick, payload.event))
        repaint();
    }),
  ];
  pi.on("session_shutdown", (_event, ctx) => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    setActive(ctx, false);
  });

  return {
    setActive,
    describe(ctx) {
      context = ctx;
      return `Lead ${leadModel() || "unselected"}: ${phaseLabel(lead)} | Sidekick ${sidekick.model || "not started"}: ${phaseLabel(sidekick)}`;
    },
  };
}
