# Copyright (c) Microsoft. All rights reserved.

"""Contoso Market — Supplements Ops specialist (multi-role).

A Microsoft Agent Framework (MAF) agent deployed to Azure AI Foundry as a hosted
agent over the `responses` protocol. The in-app Copilot SDK orchestrator ("Remi")
consults a team of these specialists, one per role:

    inventory   — stock health, expiry risk, cold-chain handling
    forecast    — demand prediction and reorder quantity
    compliance  — supplier choice and supplement regulatory checks

It can also host a fourth role, `ops-workflow`, which is NOT a single agent but a
Microsoft Agent Framework multi-agent WORKFLOW (see `workflow.py`): forecast and
inventory run in parallel, then a compliance gate makes the final go/no-go call.

One container image serves all roles. The role is selected at deploy time via the
SPECIALIST_ROLE environment variable (set per hosted-agent deployment); single-agent
roles load their instructions from `instructions/<role>.md`.

The instructions live in files so they can be evolved by the self-improving loop:
production traces -> Foundry evaluation flags a weak answer -> a GitHub agentic
workflow rewrites the instructions in a pull request -> merge -> redeploy. This is
"CI/CD for intelligence".
"""

import logging
import os
from pathlib import Path

from agent_framework import Agent
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("supplements-specialist")

# Foundry injects real environment variables at runtime; override=False keeps
# them authoritative over any local .env values.
load_dotenv(override=False)

VALID_ROLES = ("inventory", "forecast", "compliance", "ops-workflow")
INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"

# The multi-agent workflow role is hosted differently (a WorkflowAgent), not as a
# single Agent with one instructions file.
WORKFLOW_ROLE = "ops-workflow"

# Fallback if an instructions file is missing for any reason.
DEFAULT_INSTRUCTIONS = (
    "You are a supplements category operations specialist for Contoso Market. "
    "Give concise, decision-ready recommendations grounded in the product, stock, "
    "sales and supplier data provided."
)


def resolve_role() -> str:
    role = (os.environ.get("SPECIALIST_ROLE") or "inventory").strip().lower()
    if role not in VALID_ROLES:
        logger.warning("Unknown SPECIALIST_ROLE=%r; defaulting to 'inventory'", role)
        role = "inventory"
    return role


def load_instructions(role: str) -> str:
    """Load the specialist's instructions for its role from instructions/<role>.md."""
    path = INSTRUCTIONS_DIR / f"{role}.md"
    try:
        text = path.read_text(encoding="utf-8").strip()
        if text:
            logger.info("Loaded instructions from %s (%d chars)", path.name, len(text))
            return text
    except OSError as exc:
        logger.warning("Could not read %s: %s", path, exc)
    return DEFAULT_INSTRUCTIONS


def get_credential():
    """Managed identity in production; DefaultAzureCredential for local dev."""
    if os.environ.get("NODE_ENV") == "development" or os.environ.get("LOCAL_DEV") == "1":
        return DefaultAzureCredential()
    client_id = os.environ.get("AZURE_CLIENT_ID")
    return ManagedIdentityCredential(client_id=client_id) if client_id else DefaultAzureCredential()


def main() -> None:
    role = resolve_role()
    client = FoundryChatClient(
        project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
        model=os.environ["AZURE_AI_MODEL_DEPLOYMENT_NAME"],
        credential=get_credential(),
    )

    if role == WORKFLOW_ROLE:
        # Host a real MAF multi-agent workflow as a single agent. The hosting
        # infrastructure manages workflow checkpoints, so we don't set store flags.
        from workflow import build_ops_workflow

        agent = build_ops_workflow(client).as_agent()
        logger.info("Starting Ops Review WORKFLOW on the responses protocol (port 8088)")
    else:
        agent = Agent(
            client=client,
            name=f"{role}-specialist",
            instructions=load_instructions(role),
            # History is managed by the hosting infrastructure (responses protocol).
            default_options={"store": False},
        )
        logger.info("Starting %s specialist on the responses protocol (port 8088)", role)

    server = ResponsesHostServer(agent)
    server.run()


if __name__ == "__main__":
    main()
