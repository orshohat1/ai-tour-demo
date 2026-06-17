#!/usr/bin/env python3
"""Create an AGENT-TARGET batch evaluation for each hosted specialist agent.

Unlike ``run_agent_eval.py`` (which scores pre-computed responses and shows up
on the project-level *Evaluations* page), this script creates an
**agent-target** evaluation run: Foundry itself invokes the live hosted agent
over each golden query and scores the result with built-in Azure AI evaluators.

Because the run targets the agent, the evaluation is associated with that agent
and appears under the agent's **Evaluation -> Automatic Evaluation** tab in the
Foundry portal (the per-agent view).

Two details make the agent answer well inside the eval harness:
  * the run uses an ``azure_ai_target_completions`` data source whose ``target``
    is the agent, and
  * ``input_messages`` is a template that injects the agent's own instructions
    as a ``developer`` message before the ``{{item.query}}`` user message — the
    agent-target completion path otherwise replaces the agent's baked
    instructions with a generic system prompt and the agent just asks for input.

Auth uses your local ``az login`` via DefaultAzureCredential — no MCP needed.

Usage:
    .venv-deploy/bin/python scripts/run_agent_batch_eval.py compliance
    .venv-deploy/bin/python scripts/run_agent_batch_eval.py forecast
    .venv-deploy/bin/python scripts/run_agent_batch_eval.py inventory
    .venv-deploy/bin/python scripts/run_agent_batch_eval.py all
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
AGENT_VERSION = os.environ.get("AGENT_VERSION", "1")
ROOT = Path(__file__).resolve().parents[1]

# Built-in Azure AI evaluators to run against each agent response. These are
# query/response graders that read the agent's output as {{sample.output_text}}.
EVALUATORS = [
    ("Task adherence", "builtin.task_adherence"),
    ("Relevance", "builtin.relevance"),
]

ROLES = {
    "compliance": {
        "agent": "compliance-specialist",
        "dataset": ROOT / "agent" / "eval" / "compliance_golden.jsonl",
        "instructions": ROOT / "agent" / "instructions" / "compliance.md",
    },
    "forecast": {
        "agent": "forecast-specialist",
        "dataset": ROOT / "agent" / "eval" / "forecast_golden.jsonl",
        "instructions": ROOT / "agent" / "instructions" / "forecast.md",
    },
    "inventory": {
        "agent": "inventory-specialist",
        "dataset": ROOT / "agent" / "eval" / "inventory_golden.jsonl",
        "instructions": ROOT / "agent" / "instructions" / "inventory.md",
    },
}


def load_dataset(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def testing_criteria(evaluators: list[tuple[str, str]]) -> list[dict]:
    return [
        {
            "type": "azure_ai_evaluator",
            "name": label,
            "evaluator_name": evaluator,
            "initialization_parameters": {"deployment_name": JUDGE_MODEL},
            "data_mapping": {
                "query": "{{item.query}}",
                "response": "{{sample.output_text}}",
            },
        }
        for label, evaluator in evaluators
    ]


def create_eval(oai, agent_name: str):
    """Create the eval group, falling back to task_adherence only if a built-in
    evaluator is unavailable in this project."""
    data_source_config = {
        "type": "custom",
        "item_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "expected_behavior": {"type": "string"},
            },
            "required": ["query"],
        },
        "include_sample_schema": True,
    }
    try:
        return oai.evals.create(
            name=f"{agent_name} — automatic agent eval",
            data_source_config=data_source_config,
            testing_criteria=testing_criteria(EVALUATORS),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  (full evaluator set rejected: {exc}); retrying with task_adherence only")
        return oai.evals.create(
            name=f"{agent_name} — automatic agent eval",
            data_source_config=data_source_config,
            testing_criteria=testing_criteria(EVALUATORS[:1]),
        )


def run_role(oai, role: str) -> dict:
    cfg = ROLES[role]
    agent_name = cfg["agent"]
    rows = load_dataset(cfg["dataset"])
    instructions = cfg["instructions"].read_text()
    print(f"\n=== {role} -> {agent_name} ({len(rows)} cases) ===")

    eval_obj = create_eval(oai, agent_name)
    print(f"  eval={eval_obj.id}")

    run = oai.evals.runs.create(
        eval_id=eval_obj.id,
        name=f"{agent_name} v{AGENT_VERSION} — live agent run",
        data_source={
            "type": "azure_ai_target_completions",
            "source": {
                "type": "file_content",
                "content": [{"item": row} for row in rows],
            },
            "target": {
                "type": "azure_ai_agent",
                "name": agent_name,
                "version": AGENT_VERSION,
            },
            # Inject the agent's own instructions so the agent-target completion
            # path doesn't fall back to a generic "you are a helpful assistant".
            "input_messages": {
                "type": "template",
                "template": [
                    {"role": "developer", "content": instructions},
                    {"role": "user", "content": "{{item.query}}"},
                ],
            },
        },
    )
    print(f"  run={run.id} polling (Foundry is invoking the live agent)...")

    deadline = time.time() + 900
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
        "total": getattr(counts, "total", "?") if counts else "?",
    }
    print(
        f"  {agent_name}: status={res['status']} "
        f"passed={res['passed']} failed={res['failed']} total={res['total']}"
    )
    return res


def main() -> int:
    arg = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    roles = list(ROLES) if arg == "all" else [arg]
    for r in roles:
        if r not in ROLES:
            print(f"Unknown role '{r}'. Choose: {', '.join(ROLES)} or 'all'.", file=sys.stderr)
            return 1

    project = AIProjectClient(
        endpoint=PROJECT_ENDPOINT,
        credential=DefaultAzureCredential(),
        allow_preview=True,
    )
    oai = project.get_openai_client()

    results = [run_role(oai, r) for r in roles]
    print("\n========== SUMMARY ==========")
    for x in results:
        print(
            f"  {x['agent']:>22}: {x['passed']} passed / {x['failed']} failed  "
            f"(eval {x['eval_id']})"
        )
    print(
        "\nOpen each agent in the Foundry portal -> Evaluation tab -> "
        "Automatic Evaluation. The run appears there because it targets the agent."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
