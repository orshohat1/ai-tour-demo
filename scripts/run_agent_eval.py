#!/usr/bin/env python3
"""Create a Foundry evaluation for any of the three hosted specialist agents.

Runs a role's golden dataset against the LIVE hosted agent, then creates an
OpenAI-Evals-API evaluation in the Foundry project that scores each response
against its `expected_behavior` with an LLM judge (gpt-5-mini). The eval + run
show up in the Foundry portal under the agent's "Evaluation" tab and the
project-level "Evaluations" page.

Auth uses your local `az login` via DefaultAzureCredential — no MCP needed.

Usage:
    .venv-deploy/bin/python scripts/run_agent_eval.py compliance
    .venv-deploy/bin/python scripts/run_agent_eval.py forecast
    .venv-deploy/bin/python scripts/run_agent_eval.py inventory
    .venv-deploy/bin/python scripts/run_agent_eval.py all
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential

PROJECT_ENDPOINT = os.environ.get(
    "FOUNDRY_PROJECT_ENDPOINT",
    "https://aitour-foundry.services.ai.azure.com/api/projects/aitour-proj",
)
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "gpt-5-mini")
ROOT = Path(__file__).resolve().parents[1]

# Per-role config: agent name, dataset, pass threshold, and the judge rubric.
ROLES = {
    "compliance": {
        "agent": "compliance-specialist",
        "dataset": ROOT / "agent" / "eval" / "compliance_golden.jsonl",
        "threshold": 0.7,
        "judge": (
            "You are a strict evaluator for a grocery Supplier & Compliance agent. "
            "Given the user QUERY, the agent's RESPONSE, and the EXPECTED BEHAVIOR, "
            "score how well the response fulfills the expected behavior from 0.0 to 1.0. "
            "A product under an active recall or with a compliance flag MUST be put on "
            "HOLD; recommending to restock it is a critical failure and scores 0.0. "
            "Reward correct PROCEED/HOLD verdicts, sound supplier reasoning, and clear "
            "plain English. Return only the numeric score."
        ),
    },
    "forecast": {
        "agent": "forecast-specialist",
        "dataset": ROOT / "agent" / "eval" / "forecast_golden.jsonl",
        "threshold": 0.7,
        "judge": (
            "You are a strict evaluator for a grocery Demand-Forecast agent. Given the "
            "user QUERY, the agent's RESPONSE, and the EXPECTED BEHAVIOR, score how well "
            "the response fulfills the expected behavior from 0.0 to 1.0. Reward correctly "
            "weighting the trend (projecting up when rising, down when declining — not a "
            "flat average), recommending a reorder rounded to whole cases that covers "
            "delivery time plus safety stock, and NOT over-ordering declining or "
            "well-stocked items. Return only the numeric score."
        ),
    },
    "inventory": {
        "agent": "inventory-specialist",
        "dataset": ROOT / "agent" / "eval" / "inventory_golden.jsonl",
        "threshold": 0.7,
        "judge": (
            "You are a strict evaluator for a grocery Inventory agent. Given the user "
            "QUERY, the agent's RESPONSE, and the EXPECTED BEHAVIOR, score how well the "
            "response fulfills the expected behavior from 0.0 to 1.0. Reward correctly "
            "flagging low stock vs reorder point, near-expiry and expired stock (warn "
            "against over-ordering perishables; flag expired units for write-off), and "
            "cold-chain handling. Return only the numeric score."
        ),
    },
}


def load_dataset(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def run_agent(project: AIProjectClient, agent_name: str, query: str) -> str:
    oai = project.get_openai_client(agent_name=agent_name)
    resp = oai.responses.create(input=query, extra_body={"store": False}, timeout=90)
    text = getattr(resp, "output_text", None)
    if text:
        return text.strip()
    parts = []
    for item in getattr(resp, "output", []) or []:
        for c in getattr(item, "content", []) or []:
            t = getattr(c, "text", None)
            if t:
                parts.append(t)
    return "\n".join(parts).strip() or "(no answer)"


def run_role(project: AIProjectClient, oai, role: str) -> dict:
    cfg = ROLES[role]
    agent_name = cfg["agent"]
    rows = load_dataset(cfg["dataset"])
    print(f"\n=== {role} -> {agent_name} ({len(rows)} cases) ===")

    items = []
    for i, row in enumerate(rows, 1):
        q = row["query"]
        print(f"  [{i}/{len(rows)}] querying {agent_name}...", flush=True)
        try:
            answer = run_agent(project, agent_name, q)
        except Exception as e:  # noqa: BLE001
            answer = f"(agent error: {e})"
        items.append({"query": q, "expected_behavior": row.get("expected_behavior", ""), "response": answer})

    print(f"  creating eval definition for {agent_name}...")
    eval_obj = oai.evals.create(
        name=f"{agent_name} — grocery golden set",
        data_source_config={
            "type": "custom",
            "item_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "expected_behavior": {"type": "string"},
                    "response": {"type": "string"},
                },
                "required": ["query", "expected_behavior", "response"],
            },
            "include_sample_schema": False,
        },
        testing_criteria=[
            {
                "type": "score_model",
                "name": f"{role}_adherence",
                "model": JUDGE_MODEL,
                "range": [0.0, 1.0],
                "pass_threshold": cfg["threshold"],
                "input": [
                    {"role": "system", "content": cfg["judge"]},
                    {
                        "role": "user",
                        "content": (
                            "QUERY:\n{{item.query}}\n\n"
                            "EXPECTED BEHAVIOR:\n{{item.expected_behavior}}\n\n"
                            "AGENT RESPONSE:\n{{item.response}}\n\n"
                            "Score 0.0 to 1.0."
                        ),
                    },
                ],
            }
        ],
    )
    run = oai.evals.runs.create(
        eval_obj.id,
        name=f"{agent_name} v1 — baseline",
        data_source={
            "type": "jsonl",
            "source": {"type": "file_content", "content": [{"item": it} for it in items]},
        },
    )
    print(f"  eval={eval_obj.id} run={run.id} polling...")
    deadline = time.time() + 600
    final = None
    while time.time() < deadline:
        r = oai.evals.runs.retrieve(run.id, eval_id=eval_obj.id)
        if getattr(r, "status", "?") in ("completed", "failed", "canceled"):
            final = r
            break
        time.sleep(10)
    counts = getattr(final, "result_counts", None) if final else None
    res = {
        "role": role,
        "agent": agent_name,
        "eval_id": eval_obj.id,
        "run_id": run.id,
        "status": getattr(final, "status", "timeout") if final else "timeout",
        "passed": getattr(counts, "passed", "?") if counts else "?",
        "failed": getattr(counts, "failed", "?") if counts else "?",
    }
    print(f"  {agent_name}: status={res['status']} passed={res['passed']} failed={res['failed']}")
    return res


def main() -> int:
    arg = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    roles = list(ROLES) if arg == "all" else [arg]
    for r in roles:
        if r not in ROLES:
            print(f"Unknown role '{r}'. Choose: {', '.join(ROLES)} or 'all'.", file=sys.stderr)
            return 1

    cred = DefaultAzureCredential()
    project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=cred, allow_preview=True)
    oai = project.get_openai_client()

    results = [run_role(project, oai, r) for r in roles]
    print("\n========== SUMMARY ==========")
    for x in results:
        print(f"  {x['agent']:>22}: {x['passed']} passed / {x['failed']} failed  (eval {x['eval_id']})")
    print("\nOpen the Foundry portal -> project Evaluations (or each agent's Evaluation tab).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
