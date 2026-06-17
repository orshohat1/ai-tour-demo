#!/usr/bin/env python3
"""Create a Foundry evaluation for the Supplier & Compliance hosted agent.

Runs the golden dataset (agent/eval/compliance_golden.jsonl) against the LIVE
`compliance-specialist` hosted agent, then creates an OpenAI-Evals-API
evaluation in the Foundry project that scores each response against its
`expected_behavior` with an LLM judge (gpt-5-mini). The eval + run show up in
the Foundry portal "Evaluation" tab.

Auth uses your local `az login` via DefaultAzureCredential — no MCP needed.

Usage:
    .venv-deploy/bin/python scripts/run_compliance_eval.py
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
AGENT_NAME = os.environ.get("AGENT_COMPLIANCE_NAME", "compliance-specialist")
JUDGE_MODEL = os.environ.get("EVAL_JUDGE_MODEL", "gpt-5-mini")
PASS_THRESHOLD = float(os.environ.get("EVAL_PASS_THRESHOLD", "0.7"))

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "agent" / "eval" / "compliance_golden.jsonl"


def load_dataset() -> list[dict]:
    rows = []
    for line in DATASET.read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def run_agent(project: AIProjectClient, query: str) -> str:
    """Invoke the hosted compliance agent and return its text answer."""
    oai = project.get_openai_client(agent_name=AGENT_NAME)
    resp = oai.responses.create(input=query, extra_body={"store": False})
    # responses API: prefer output_text, fall back to assembling output items
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


JUDGE_SYSTEM = (
    "You are a strict evaluator for a grocery Supplier & Compliance agent. "
    "Given the user QUERY, the agent's RESPONSE, and the EXPECTED BEHAVIOR, "
    "score how well the response fulfills the expected behavior on a scale of "
    "0.0 to 1.0. A product under an active recall or with a compliance flag "
    "MUST be put on HOLD; recommending to restock it is a critical failure and "
    "should score 0.0. Reward correct PROCEED/HOLD verdicts, correct supplier "
    "reasoning, and clear plain-English answers. Return only the numeric score."
)


def main() -> int:
    if not DATASET.exists():
        print(f"Dataset not found: {DATASET}", file=sys.stderr)
        return 1

    cred = DefaultAzureCredential()
    project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=cred, allow_preview=True)
    oai = project.get_openai_client()

    rows = load_dataset()
    print(f"Loaded {len(rows)} golden cases. Invoking '{AGENT_NAME}' on each...")

    items = []
    for i, row in enumerate(rows, 1):
        q = row["query"]
        exp = row.get("expected_behavior", "")
        print(f"  [{i}/{len(rows)}] querying agent...", flush=True)
        try:
            answer = run_agent(project, q)
        except Exception as e:  # noqa: BLE001
            answer = f"(agent error: {e})"
        items.append({"query": q, "expected_behavior": exp, "response": answer})

    print("\nCreating the evaluation definition (LLM-judge grader)...")
    eval_obj = oai.evals.create(
        name="compliance-specialist — grocery golden set",
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
                "name": "compliance_adherence",
                "model": JUDGE_MODEL,
                "range": [0.0, 1.0],
                "pass_threshold": PASS_THRESHOLD,
                "input": [
                    {"role": "system", "content": JUDGE_SYSTEM},
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
    eval_id = eval_obj.id
    print(f"  eval created: {eval_id}")

    print("Creating the run (scoring the agent's answers)...")
    run = oai.evals.runs.create(
        eval_id,
        name=f"{AGENT_NAME} v1 — baseline",
        data_source={
            "type": "jsonl",
            "source": {"type": "file_content", "content": [{"item": it} for it in items]},
        },
    )
    run_id = run.id
    print(f"  run created: {run_id}  status={getattr(run, 'status', '?')}")

    print("\nPolling for results...")
    deadline = time.time() + 600
    final = None
    while time.time() < deadline:
        r = oai.evals.runs.retrieve(run_id, eval_id=eval_id)
        status = getattr(r, "status", "?")
        print(f"  status={status}", flush=True)
        if status in ("completed", "failed", "canceled"):
            final = r
            break
        time.sleep(10)

    if final is None:
        print("Timed out waiting for run. Check the portal.")
        return 0

    counts = getattr(final, "result_counts", None)
    print("\n=== RESULT ===")
    print(f"  eval_id: {eval_id}")
    print(f"  run_id:  {run_id}")
    print(f"  status:  {getattr(final, 'status', '?')}")
    if counts:
        print(f"  passed:  {getattr(counts, 'passed', '?')}")
        print(f"  failed:  {getattr(counts, 'failed', '?')}")
        print(f"  errored: {getattr(counts, 'errored', '?')}")
    print("\nOpen the Foundry portal → Evaluation tab to see per-row scores.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
