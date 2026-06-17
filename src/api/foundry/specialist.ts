// Multi-agent router for Contoso Market — Supplements Ops Hub.
//
// The Copilot SDK orchestrator ("Remi") consults a TEAM of Microsoft Agent
// Framework (MAF) agents deployed as Foundry hosted agents (responses protocol).
// Each specialist owns one kind of judgement:
//
//   inventory   — stock health, expiry risk, cold-chain handling
//   forecast    — demand prediction and reorder quantity
//   compliance  — supplier choice, lead time, and supplement regulatory checks
//
// This is the SDK ⇄ Foundry hand-off: the fast interactive orchestrator delegates
// deep, governed reasoning to the right production agent.
//
// Resolution paths per specialist, selected by environment:
//   1. Foundry hosted agent  — FOUNDRY_PROJECT_ENDPOINT + AGENT_<ROLE>_NAME
//   2. Local container       — AGENT_<ROLE>_LOCAL_URL (MAF adapter on :8088)
//   3. Deterministic fallback — keeps the app working before agents are deployed
//
// Auth uses a bearer token from DefaultAzureCredential (local dev) or
// ManagedIdentityCredential (production), per Azure passwordless best practices.

import {
  formatUsd,
  getSalesHistory,
  getSupplier,
  listSuppliers,
  type Product,
} from "../data/store.js";

export type SpecialistRole = "inventory" | "forecast" | "compliance" | "ops";

export interface SpecialistContext {
  /** Products relevant to the question. */
  products: Product[];
  /** The orchestrator's concise question for the specialist. */
  question: string;
}

export interface SpecialistAnswer {
  role: SpecialistRole;
  source: "foundry" | "local-container" | "fallback";
  agentName?: string;
  /** The specialist's recommendation in plain language. */
  recommendation: string;
  /** Structured hints the orchestrator can act on (optional). */
  data?: Record<string, unknown>;
}

const SCOPE = "https://ai.azure.com/.default";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: { token: string; expiresOn: number } | null = null;
let cachedCredential: { getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number } | null> } | null =
  null;

async function getBearerToken(): Promise<string | undefined> {
  if (cachedToken && Date.now() < cachedToken.expiresOn - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.token;
  }
  try {
    if (!cachedCredential) {
      const identity = await import("@azure/identity");
      cachedCredential =
        process.env.NODE_ENV === "development"
          ? new identity.DefaultAzureCredential()
          : process.env.AZURE_CLIENT_ID
            ? new identity.ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
            : new identity.ManagedIdentityCredential();
    }
    const result = await cachedCredential.getToken(SCOPE);
    if (!result) return undefined;
    cachedToken = { token: result.token, expiresOn: result.expiresOnTimestamp };
    return result.token;
  } catch {
    return undefined;
  }
}

/** Per-role agent name + local URL from the environment. */
function roleConfig(role: SpecialistRole): { agentName?: string; localUrl?: string } {
  const key = role.toUpperCase();
  return {
    agentName: process.env[`AGENT_${key}_NAME`],
    localUrl: process.env[`AGENT_${key}_LOCAL_URL`]?.replace(/\/$/, ""),
  };
}

/** Render the product context the specialist reasons over. */
function renderProducts(products: Product[]): string {
  return products
    .map((p) => {
      const sales = getSalesHistory(p.id);
      const supplier = getSupplier(p.supplierId);
      const recent = sales ? sales.weekly.map((w) => w.units).join(", ") : "n/a";
      const reliability = supplier ? `${Math.round(supplier.reliability * 100)}% on-time` : "on-time rate unknown";
      const lead = supplier ? `delivers in about ${supplier.leadTimeDays} days` : "delivery time unknown";
      return [
        `- ${p.id} ${p.name} (${p.brand}, ${p.category})`,
        `  in stock=${p.stock}, reorder when at or below=${p.reorderPoint}, units per case=${p.caseSize}, best-before=${p.expiryDate}, needs refrigeration=${p.coldChain ? "yes" : "no"}`,
        `  supplier=${supplier?.name ?? p.supplierId} (${lead}, ${reliability})`,
        `  recent weekly sales (oldest to newest)=[${recent}]${sales ? ` — ${sales.trendNote}` : ""}`,
        p.complianceFlag ? `  SAFETY/COMPLIANCE: ${p.complianceFlag}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

const ROLE_BRIEF: Record<SpecialistRole, string> = {
  inventory:
    "You are the Inventory specialist. Assess stock health, expiry risk, and whether refrigerated items are handled correctly. Flag products that are close to their best-before date or are being over-ordered.",
  forecast:
    "You are the Demand-Forecast specialist. Predict next week's sales from the recent sales history and trend, then recommend how much to reorder (in whole cases) to cover the supplier's delivery time plus a small safety buffer.",
  compliance:
    "You are the Supplier & Compliance specialist. Recommend the best supplier (balancing delivery speed, on-time record and minimum order), and check each product for food-safety or product-recall problems. If a product has a safety flag, recommend HOLD until it is reviewed.",
  ops:
    "You are the Ops Review team — a multi-agent workflow. A demand-forecast specialist and an inventory specialist look at the products in parallel, then a supplier & compliance gate makes the final go/no-go call. Food-safety and product-recall review comes FIRST: any product under an active recall or with a compliance flag is HELD regardless of demand. Otherwise recommend the reorder (whole cases, covering delivery time plus a small safety buffer) and the best supplier.",
};

function renderPrompt(role: SpecialistRole, ctx: SpecialistContext): string {
  return [
    ROLE_BRIEF[role],
    "",
    "Question from the category manager's assistant:",
    ctx.question,
    "",
    "Relevant products:",
    renderProducts(ctx.products),
    "",
    "Respond with a short, clear recommendation in plain English (2-5 sentences). Avoid jargon and abbreviations — write 'about 14 days' not 'lead 14d', and '92% on-time' not '0.92'. Be specific with product names, quantities (in cases and units), and the supplier.",
  ].join("\n");
}

interface ResponsesResult {
  text: string;
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.output_text === "string") return p.output_text;
  if (Array.isArray(p.output)) {
    const parts: string[] = [];
    for (const item of p.output) {
      const content = (item as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const text = (c as Record<string, unknown>)?.text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  const choices = p.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
  }
  return "";
}

async function callResponsesEndpoint(url: string, prompt: string, bearer: string | undefined): Promise<ResponsesResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const body: Record<string, unknown> = { input: prompt, stream: false };
  if (process.env.FOUNDRY_MODEL_DEPLOYMENT_NAME) body.model = process.env.FOUNDRY_MODEL_DEPLOYMENT_NAME;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Specialist endpoint returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    return { text: extractResponsesText(await res.json()) };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Deterministic fallbacks (used before agents are deployed, or on failure) ----

function projectNextWeekDemand(productId: string): number {
  const sales = getSalesHistory(productId);
  if (!sales || sales.weekly.length === 0) return 0;
  const last3 = sales.weekly.slice(-3).map((w) => w.units);
  const avg = last3.reduce((a, b) => a + b, 0) / last3.length;
  // Simple trend: extrapolate the recent slope by one week.
  const slope = sales.weekly.length >= 2 ? sales.weekly.at(-1)!.units - sales.weekly.at(-2)!.units : 0;
  return Math.max(0, Math.round(avg + slope));
}

function fallbackInventory(ctx: SpecialistContext): SpecialistAnswer {
  const notes = ctx.products.map((p) => {
    const days = Math.round(
      (new Date(p.expiryDate).getTime() - new Date("2026-06-14T00:00:00Z").getTime()) / (1000 * 60 * 60 * 24),
    );
    const low = p.stock <= p.reorderPoint;
    const nearExpiry = days <= 75;
    const bits = [`${p.name}: ${p.stock} in stock (reorder at ${p.reorderPoint})${low ? " — running low" : ""}`];
    if (nearExpiry) bits.push(`best-before in about ${days} days, so don't over-order`);
    if (p.coldChain) bits.push("needs refrigeration — keep orders to a size you can store cold");
    return bits.join("; ");
  });
  return {
    role: "inventory",
    source: "fallback",
    recommendation: `Here's the stock review — ${notes.join(" | ")}.`,
    data: { products: ctx.products.map((p) => p.id) },
  };
}

function fallbackForecast(ctx: SpecialistContext): SpecialistAnswer {
  const recs = ctx.products.map((p) => {
    const supplier = getSupplier(p.supplierId);
    const weeklyDemand = projectNextWeekDemand(p.id);
    const leadWeeks = Math.ceil((supplier?.leadTimeDays ?? 14) / 7);
    const need = weeklyDemand * (leadWeeks + 1) + Math.ceil(weeklyDemand * 0.5) - p.stock; // cover lead + 1wk + safety
    const cases = Math.max(0, Math.ceil(need / p.caseSize));
    return { id: p.id, name: p.name, weeklyDemand, cases, units: cases * p.caseSize };
  });
  const summary = recs
    .map((r) => `${r.name}: selling about ${r.weeklyDemand} a week, so reorder ${r.cases} case(s) (${r.units} units)`)
    .join("; ");
  return {
    role: "forecast",
    source: "fallback",
    recommendation: `Here's the demand forecast and what to reorder — ${summary}.`,
    data: { recommendations: recs },
  };
}

function fallbackCompliance(ctx: SpecialistContext): SpecialistAnswer {
  const flags = ctx.products.filter((p) => p.complianceFlag);
  const bySupplier = ctx.products.map((p) => {
    const s = getSupplier(p.supplierId);
    const lead = s ? `delivers in about ${s.leadTimeDays} days` : "delivery time unknown";
    const rel = s ? `${Math.round(s.reliability * 100)}% on-time` : "on-time rate unknown";
    return `${p.name} comes from ${s?.name ?? p.supplierId} (${lead}, ${rel})`;
  });
  const best = [...listSuppliers()].sort(
    (a, b) => b.reliability - a.reliability || a.leadTimeDays - b.leadTimeDays,
  )[0];
  const complianceText = flags.length
    ? `Put ${flags.map((p) => p.name).join(", ")} on HOLD until reviewed — ${flags[0].complianceFlag}`
    : "No safety or recall problems found on these items.";
  return {
    role: "compliance",
    source: "fallback",
    recommendation: `${bySupplier.join("; ")}. The most reliable supplier overall is ${best?.name}. ${complianceText}`,
    data: { holds: flags.map((p) => p.id) },
  };
}

/**
 * Ops Review fallback — mirrors the hosted multi-agent workflow locally: run the
 * forecast and inventory reasoning in parallel, then apply the compliance gate
 * (an active recall / compliance flag forces HOLD regardless of demand).
 */
function fallbackOps(ctx: SpecialistContext): SpecialistAnswer {
  const forecast = fallbackForecast(ctx);
  const inventory = fallbackInventory(ctx);
  const flags = ctx.products.filter((p) => p.complianceFlag);
  const best = [...listSuppliers()].sort(
    (a, b) => b.reliability - a.reliability || a.leadTimeDays - b.leadTimeDays,
  )[0];

  const gate = flags.length
    ? `HOLD — do not reorder ${flags.map((p) => p.name).join(", ")}: ${flags[0].complianceFlag}. Food-safety review overrides demand.`
    : `Go ahead — no recall or compliance problems. Best supplier overall is ${best?.name}.`;

  return {
    role: "ops",
    source: "fallback",
    recommendation: `Ops Review (forecast + inventory in parallel, then compliance gate): ${forecast.recommendation} ${inventory.recommendation} Final decision: ${gate}`,
    data: {
      forecast: forecast.data,
      inventory: inventory.data,
      holds: flags.map((p) => p.id),
    },
  };
}

function fallback(role: SpecialistRole, ctx: SpecialistContext): SpecialistAnswer {
  if (role === "inventory") return fallbackInventory(ctx);
  if (role === "forecast") return fallbackForecast(ctx);
  if (role === "ops") return fallbackOps(ctx);
  return fallbackCompliance(ctx);
}

/**
 * Consult one specialist agent. Tries a local container, then the Foundry hosted
 * agent, then a deterministic fallback so the app always returns a usable answer.
 */
export async function consultSpecialist(role: SpecialistRole, ctx: SpecialistContext): Promise<SpecialistAnswer> {
  const prompt = renderPrompt(role, ctx);
  const { agentName, localUrl } = roleConfig(role);

  if (localUrl) {
    try {
      const { text } = await callResponsesEndpoint(`${localUrl}/responses`, prompt, undefined);
      if (text) return { role, source: "local-container", agentName: agentName ?? "local", recommendation: text };
    } catch (err) {
      console.warn(`Local ${role} agent failed, falling back: ${(err as Error).message}`);
    }
  }

  const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT?.replace(/\/$/, "");
  if (projectEndpoint && agentName) {
    try {
      // The hosted-agent responses endpoint requires the api-version query param.
      const apiVersion = process.env.FOUNDRY_API_VERSION || "v1";
      const url = `${projectEndpoint}/agents/${agentName}/endpoint/protocols/openai/responses?api-version=${apiVersion}`;
      const bearer = await getBearerToken();
      const { text } = await callResponsesEndpoint(url, prompt, bearer);
      if (text) return { role, source: "foundry", agentName, recommendation: text };
    } catch (err) {
      console.warn(`Foundry ${role} agent failed, falling back: ${(err as Error).message}`);
    }
  }

  return fallback(role, ctx);
}

/** Friendly display name per specialist, for logs and the UI. */
export const ROLE_LABEL: Record<SpecialistRole, string> = {
  inventory: "Inventory specialist",
  forecast: "Demand-Forecast specialist",
  compliance: "Supplier & Compliance specialist",
  ops: "Ops Review workflow",
};

export { formatUsd };
