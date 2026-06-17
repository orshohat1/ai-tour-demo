import { Router } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionConfig } from "@github/copilot-sdk";
import { getClient } from "../client.js";
import { getSessionOptions, enhanceModelError } from "../model-config.js";
import { customTools, TOOL_LABELS } from "../tools/tools.js";
import { REMI_SYSTEM_MESSAGE } from "../assistant.js";
import { getProduct } from "../data/store.js";

const router = Router();

// Approve every permission request so the assistant's tools run headlessly on
// the server. Our custom tools enforce their own business rules; the SDK's
// built-in file/shell/url operations are not used by this app.
const approveAllPermissions = (
  _request: PermissionRequest,
  _invocation: { sessionId: string },
): PermissionRequestResult => ({ kind: "approved" });

// Directory of Copilot SDK skills (SKILL.md playbooks) loaded into every session.
// In the container the skills are copied to /app/skills; in dev they live in
// src/api/skills — both resolve from the process working directory.
const SKILLS_DIR = process.env.SKILLS_DIR ?? resolve(process.cwd(), "skills");
const SKILLS_AVAILABLE = existsSync(SKILLS_DIR);

type SessionLike = {
  on(event: string, cb: (e: unknown) => void): () => void;
  send(msg: { prompt: string }): Promise<void>;
  destroy(): Promise<void>;
};

/** Wait for the session to become idle or error, with a configurable timeout. */
function waitForIdle(
  session: SessionLike,
  timeoutMs = Number(process.env.CHAT_TIMEOUT_MS ?? 240_000),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubIdle();
      unsubError();
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for response`));
    }, timeoutMs);

    const unsubIdle = session.on("session.idle", () => {
      clearTimeout(timer);
      unsubIdle();
      unsubError();
      resolve();
    });

    const unsubError = session.on("session.error", (event: unknown) => {
      clearTimeout(timer);
      unsubIdle();
      unsubError();
      const msg = (event as { data?: { message?: string } })?.data?.message ?? "Unknown session error";
      reject(new Error(`Session error: ${msg}`));
    });
  });
}

const ALLOWED_ROLES = new Set(["user", "assistant"]);

function isValidHistoryItem(item: unknown): item is { role: string; content: string } {
  return (
    item !== null &&
    typeof item === "object" &&
    typeof (item as Record<string, unknown>).role === "string" &&
    ALLOWED_ROLES.has((item as Record<string, unknown>).role as string) &&
    typeof (item as Record<string, unknown>).content === "string"
  );
}

/** Compact a tool's arguments into the "question" Remi sent the specialist/tool. */
function summarizeArgs(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  if (name.startsWith("consult_")) {
    const q = typeof a.question === "string" ? a.question : "";
    const ids = Array.isArray(a.productIds) ? a.productIds.join(", ") : "";
    return [q, ids && `Context SKUs: ${ids}`].filter(Boolean).join("\n");
  }
  if (name === "create_purchase_order") {
    const lines = Array.isArray(a.lines)
      ? a.lines
          .map((l) => {
            const o = l as Record<string, unknown>;
            return `${o.productId} ×${o.units}`;
          })
          .join(", ")
      : "";
    return `Supplier ${a.supplierId ?? "?"} · ${lines}${a.submit === true ? " · submit" : " · draft"}`;
  }
  if (name === "request_approval") {
    const action = typeof a.action === "string" ? a.action : "";
    const detail = typeof a.detail === "string" ? a.detail : "";
    return [action, detail].filter(Boolean).join("\n");
  }
  const compact = JSON.stringify(a);
  return compact === "{}" ? undefined : compact.slice(0, 400);
}

/** Pull the specialist/tool's textual reply out of a tool result object. */
function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const content = typeof r.content === "string" ? r.content : undefined;
  if (!content) return undefined;
  // Tool results are JSON; surface the specialist's recommendation when present.
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      const rec = p.recommendation ?? p.message;
      const by = typeof p.handledBy === "string" ? p.handledBy : undefined;
      if (typeof rec === "string") return by ? `${rec}\n\n— ${by}` : rec;
    }
  } catch {
    /* not JSON — fall through */
  }
  return content.slice(0, 600);
}

const TODAY = new Date().toISOString().slice(0, 10);

router.post("/chat", async (req, res) => {
  const { message, history } = req.body as {
    message?: unknown;
    history?: unknown;
  };

  if (message === undefined || message === null) {
    res.status(400).json({ error: "Missing 'message' field" });
    return;
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "'message' must be a non-empty string" });
    return;
  }
  if (history !== undefined && !Array.isArray(history)) {
    res.status(400).json({ error: "'history' must be an array" });
    return;
  }
  if (Array.isArray(history) && !history.every(isValidHistoryItem)) {
    res.status(400).json({ error: "Each history item must have 'role' ('user'|'assistant') and 'content' strings" });
    return;
  }

  // Build prompt before flushing SSE headers so validation errors return JSON 400
  const prompt = Array.isArray(history) && history.length > 0
    ? [...history.map((h) => `${h.role}: ${h.content}`), `user: ${message}`].join("\n")
    : message;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let session: SessionLike | null = null;
  const unsubscribers: Array<() => void> = [];

  const writeEvent = (payload: unknown) => {
    if (res.socket?.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const copilot = await getClient();
    const baseOptions = await getSessionOptions({ streaming: true });

    // Lifecycle HOOKS — the SDK invokes these at well-defined points. We surface
    // them in the UI so the audience can see governance happening in sequence,
    // and they take REAL effect (inject grounding context; block flagged POs).
    const hooks: SessionConfig["hooks"] = {
      onSessionStart: () => {
        writeEvent({
          hook: { id: "hook-start", name: "onSessionStart", label: "Session started", detail: "Copilot SDK session opened with Remi's tools, skills and guardrails." },
        });
      },
      onUserPromptSubmitted: () => {
        writeEvent({
          hook: {
            id: "hook-prompt",
            name: "onUserPromptSubmitted",
            label: "Grounding context injected",
            detail: `Added operational context: today is ${TODAY}; store = Contoso Market; category = grocery; currency = USD.`,
          },
        });
        return {
          additionalContext: `Operational context — today's date is ${TODAY}. Store: Contoso Market. Category: grocery. Currency: USD.`,
        };
      },
      onPreToolUse: (input) => {
        // Compliance guardrail: block restocking (PO or direct receipt) of any
        // compliance-flagged SKU, no matter what the model decided.
        const restockTools = new Set(["create_purchase_order", "receive_stock"]);
        if (!restockTools.has(input.toolName)) return;
        const args = input.toolArgs as
          | { productId?: string; lines?: Array<{ productId?: string }> }
          | undefined;
        const candidateIds =
          input.toolName === "create_purchase_order"
            ? (args?.lines ?? []).map((l) => l?.productId)
            : [args?.productId];
        const flagged = candidateIds.filter(
          (id): id is string => typeof id === "string" && Boolean(getProduct(id)?.complianceFlag),
        );
        if (flagged.length > 0) {
          writeEvent({
            hook: { id: `hook-guard-${flagged.join("-")}`, name: "onPreToolUse", label: "Compliance guardrail blocked restock", blocked: true, detail: `Restock denied: ${flagged.join(", ")} carry a compliance flag and cannot be restocked.` },
          });
          return {
            permissionDecision: "deny" as const,
            permissionDecisionReason: `Compliance guardrail: ${flagged.join(", ")} carry a compliance flag and must not be restocked.`,
          };
        }
        writeEvent({
          hook: { id: "hook-guard", name: "onPreToolUse", label: "Restock pre-checked", detail: "Compliance guardrail ran before restocking — no flagged SKUs, allowed." },
        });
      },
    };

    // Compose the in-app assistant: model/provider config (from getSessionOptions)
    // + Remi's persona + the custom tools that act on the Supplements Ops backend
    // + the SKILL.md playbooks Remi consults + lifecycle hooks.
    // onPermissionRequest approves operations so tools run headlessly on the
    // server (the tools themselves enforce business rules).
    const options = {
      ...baseOptions,
      tools: customTools,
      systemMessage: REMI_SYSTEM_MESSAGE,
      onPermissionRequest: approveAllPermissions,
      hooks,
      ...(SKILLS_AVAILABLE ? { skillDirectories: [SKILLS_DIR] } : {}),
    };
    session = (await copilot.createSession(options)) as unknown as SessionLike;

    // Correlate start/complete events by toolCallId — the complete event does
    // not carry the tool name, so we remember it from the start event.
    const toolNamesByCallId = new Map<string, string>();
    const readData = (event: unknown) => (event as { data?: Record<string, unknown> })?.data ?? {};

    // Stream token-level text deltas.
    unsubscribers.push(
      session.on("assistant.message_delta", (event: unknown) => {
        const delta = (event as { data?: { deltaContent?: string } })?.data?.deltaContent ?? "";
        if (delta) writeEvent({ content: delta });
      }),
    );

    // Surface SKILL invocations — Remi pulling in a governed playbook. This is
    // the same "Read skill …" beat you see in Copilot, shown in the timeline.
    unsubscribers.push(
      session.on("skill.invoked", (event: unknown) => {
        const data = readData(event);
        const name = (data.name as string) ?? "skill";
        const content = typeof data.content === "string" ? data.content : "";
        writeEvent({ skill: { id: `skill-${name}`, name, label: `Consulted skill: ${name}`, detail: content.slice(0, 1200) } });
      }),
    );

    // Surface tool activity AND the request/response payloads so the UI can show
    // the actual conversation between Remi and each backend tool / Foundry agent.
    // The internal "skill" runner tool is represented by skill.invoked instead.
    unsubscribers.push(
      session.on("tool.execution_start", (event: unknown) => {
        const data = readData(event);
        const name = (data.toolName as string) ?? "tool";
        if (name === "skill" || name === "report_intent") return;
        const callId = (data.toolCallId as string) ?? name;
        toolNamesByCallId.set(callId, name);
        writeEvent({
          tool: { callId, name, phase: "start", label: TOOL_LABELS[name] ?? name, request: summarizeArgs(name, data.arguments) },
        });
        // HUMAN-IN-THE-LOOP: when Remi asks for approval, emit an approval event
        // so the UI can render Approve / Decline buttons for the human.
        if (name === "request_approval") {
          const a = (data.arguments ?? {}) as Record<string, unknown>;
          writeEvent({
            approval: {
              action: typeof a.action === "string" ? a.action : "Confirm action",
              detail: typeof a.detail === "string" ? a.detail : "",
            },
          });
        }
      }),
    );
    unsubscribers.push(
      session.on("tool.execution_complete", (event: unknown) => {
        const data = readData(event);
        const callId = (data.toolCallId as string) ?? "";
        const name = toolNamesByCallId.get(callId) ?? "tool";
        if (name === "skill" || name === "report_intent") return;
        const success = data.success !== false;
        writeEvent({
          tool: { callId, name, phase: "complete", success, label: TOOL_LABELS[name] ?? name, response: summarizeResult(data.result) },
        });
      }),
    );

    await session.send({ prompt });
    await waitForIdle(session);

    if (!res.socket?.destroyed) {
      res.write(`data: [DONE]\n\n`);
    }
    res.end();
  } catch (err) {
    const enhanced = enhanceModelError(err);
    if (!res.socket?.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: enhanced.message })}\n\n`);
    }
    res.end();
  } finally {
    for (const unsub of unsubscribers) unsub();
    await session?.destroy();
  }
});

export default router;
