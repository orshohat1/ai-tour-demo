#!/usr/bin/env python3
"""Deploy the Contoso Market grocery specialists as Foundry hosted agents.

One container image serves every role; the SPECIALIST_ROLE environment variable
(set per agent version) selects which behaviour the container runs with:

    inventory | forecast | compliance  -> a single hosted Agent
    ops-workflow                       -> a multi-agent MAF WORKFLOW (workflow.py)

Uses the Azure AI Projects SDK (azure-ai-projects >= 2.1.0). Run inside a venv:

    python -m venv .venv && . .venv/bin/activate
    pip install "azure-ai-projects>=2.1.0" azure-identity
    python scripts/deploy_agents.py \
        --endpoint https://aitour-foundry.services.ai.azure.com/api/projects/aitour-proj \
        --image acraitourahqjly.azurecr.io/supplements-specialist:<TAG> \
        --model gpt-5-mini

Authentication uses DefaultAzureCredential (picks up `az login`).
"""

from __future__ import annotations

import argparse
import sys
import time

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import (
    AgentProtocol,
    ContainerConfiguration,
    HostedAgentDefinition,
    ProtocolVersionRecord,
)
from azure.identity import DefaultAzureCredential

ROLES = ("inventory", "forecast", "compliance", "ops-workflow")

# The ops-workflow role hosts three sub-agents in one container, so give it more
# headroom than the single-agent specialists.
RESOURCES = {
    "ops-workflow": {"cpu": "1", "memory": "2Gi"},
}
DEFAULT_RESOURCES = {"cpu": "0.5", "memory": "1Gi"}


def deploy_role(project: AIProjectClient, role: str, image: str, model: str) -> str:
    agent_name = f"{role}-specialist"
    res = RESOURCES.get(role, DEFAULT_RESOURCES)
    print(f"\n=== Creating hosted agent '{agent_name}' (role={role}) ===")
    agent = project.agents.create_version(
        agent_name=agent_name,
        definition=HostedAgentDefinition(
            protocol_versions=[
                ProtocolVersionRecord(protocol=AgentProtocol.RESPONSES, version="1.0.0"),
            ],
            cpu=res["cpu"],
            memory=res["memory"],
            container_configuration=ContainerConfiguration(image=image),
            environment_variables={
                "AZURE_AI_MODEL_DEPLOYMENT_NAME": model,
                "SPECIALIST_ROLE": role,
            },
        ),
    )
    print(f"  created {agent.name}, version {agent.version}")
    return agent_name, agent.version


def wait_active(project: AIProjectClient, agent_name: str, version: str, timeout_s: int = 300) -> str:
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        info = project.agents.get_version(agent_name=agent_name, agent_version=version)
        status = info.get("status") if isinstance(info, dict) else getattr(info, "status", None)
        if status != last:
            print(f"  {agent_name} v{version}: {status}")
            last = status
        if status == "active":
            return "active"
        if status == "failed":
            err = info.get("error") if isinstance(info, dict) else getattr(info, "error", None)
            print(f"  {agent_name} FAILED: {err}", file=sys.stderr)
            return "failed"
        time.sleep(5)
    print(f"  {agent_name}: timed out waiting for active", file=sys.stderr)
    return "timeout"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="Foundry project endpoint URL")
    parser.add_argument("--image", required=True, help="Full ACR image URL with tag")
    parser.add_argument("--model", default="gpt-5-mini", help="Model deployment name")
    parser.add_argument("--roles", nargs="*", default=list(ROLES), help="Subset of roles to deploy")
    args = parser.parse_args()

    project = AIProjectClient(
        endpoint=args.endpoint,
        credential=DefaultAzureCredential(),
        allow_preview=True,
    )

    results: dict[str, str] = {}
    pending: list[tuple[str, str]] = []
    for role in args.roles:
        if role not in ROLES:
            print(f"Skipping unknown role: {role}", file=sys.stderr)
            continue
        agent_name, version = deploy_role(project, role, args.image, args.model)
        pending.append((agent_name, version))

    print("\n=== Waiting for agents to become active ===")
    for agent_name, version in pending:
        results[agent_name] = wait_active(project, agent_name, version)

    print("\n=== Summary ===")
    ok = True
    for name, status in results.items():
        print(f"  {name}: {status}")
        ok = ok and status == "active"
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
