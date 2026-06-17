# Copyright (c) Microsoft. All rights reserved.

"""Ops Review — a real Microsoft Agent Framework (MAF) multi-agent WORKFLOW.

Two specialists run **concurrently**, then their
answers fan in to a **compliance gate** that makes the final go / no-go call.

    dispatcher
       |--->  forecast   (AgentExecutor)  --|
       |--->  inventory  (AgentExecutor)  --|   (fan-in)
                                            v
                                   compliance-gate  (custom Executor)
                                            v
                                   compliance (AgentExecutor)  --->  output

Unlike the three standalone specialists (each a single hosted Agent), this builds
a genuine workflow GRAPH and hosts it as ONE Foundry agent over the responses
protocol via ``workflow.as_agent()``. Foundry emits ``workflow_action`` trace
events as each executor runs, so the parallel fan-out and the compliance gate are
visible on the agent's Traces tab.

Decision rule baked into the gate: **food-safety / recall review comes FIRST** —
an active recall or compliance flag forces HOLD regardless of demand.
"""

from __future__ import annotations

from pathlib import Path

from agent_framework import (
    Agent,
    AgentExecutor,
    AgentExecutorRequest,
    AgentExecutorResponse,
    Executor,
    Message,
    Workflow,
    WorkflowBuilder,
    WorkflowContext,
    handler,
)

INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"

# Shared-state key used to carry the original request (with full product context,
# including any recall / compliance flag) from the dispatcher to the gate. The two
# parallel specialists summarise the request, but the gate needs the raw context to
# apply the recall rule reliably.
_ORIGINAL_INPUT_KEY = "ops_original_request"


def _load_instructions(role: str, fallback: str) -> str:
    path = INSTRUCTIONS_DIR / f"{role}.md"
    try:
        text = path.read_text(encoding="utf-8").strip()
        return text or fallback
    except OSError:
        return fallback


class DispatchToSpecialists(Executor):
    """Start / fan-out node.

    Broadcasts the incoming request to the forecast and inventory specialists and
    stashes the original request in shared state so the compliance gate can see the
    full product context (recall flags included).

    When the workflow is hosted as an agent (``workflow.as_agent()``), the user's
    turn arrives as ``list[Message]`` — so the START executor must accept that type.
    """

    @handler
    async def dispatch(self, messages: list[Message], ctx: WorkflowContext[AgentExecutorRequest]) -> None:
        # Keep the raw user text so the compliance gate can re-check for recalls.
        original = "\n".join(m.text for m in messages if getattr(m, "text", None)).strip()
        ctx.set_state(_ORIGINAL_INPUT_KEY, original)
        # A fan-out edge broadcasts these messages to all targets concurrently.
        await ctx.send_message(AgentExecutorRequest(messages=list(messages), should_respond=True))


class ComplianceGate(Executor):
    """Fan-in node + decision gate.

    Collects the forecast and inventory answers (run in parallel), then hands the
    whole picture to the compliance specialist for the final go / no-go decision.
    """

    @handler
    async def gate(
        self,
        results: list[AgentExecutorResponse],
        ctx: WorkflowContext[AgentExecutorRequest],
    ) -> None:
        by_id = {r.executor_id: r.agent_response.text for r in results}
        forecast_text = by_id.get("forecast", "(no forecast provided)")
        inventory_text = by_id.get("inventory", "(no inventory assessment provided)")
        original = ctx.get_state(_ORIGINAL_INPUT_KEY) or ""

        gate_prompt = (
            "You are the FINAL decision gate for a grocery reorder. Two specialists "
            "have already reported in parallel; now make the go / no-go call.\n\n"
            "FOOD-SAFETY / RECALL REVIEW COMES FIRST: if any product is under an active "
            "recall or carries a compliance flag, the decision is HOLD — do not reorder it — "
            "no matter how strong demand looks. Otherwise, pick the best supplier and confirm "
            "the reorder.\n\n"
            f"=== ORIGINAL REQUEST (with product, stock and supplier context) ===\n{original}\n\n"
            f"=== FORECAST SPECIALIST SAID ===\n{forecast_text}\n\n"
            f"=== INVENTORY SPECIALIST SAID ===\n{inventory_text}\n\n"
            "Give the FINAL recommendation in plain English (3-6 sentences): state the "
            "go / no-go decision first, then the reorder quantity in cases and units (or why it "
            "is on HOLD), the chosen supplier, and any expiry / cold-chain caveats."
        )
        await ctx.send_message(
            AgentExecutorRequest(
                messages=[Message("user", contents=[gate_prompt])],
                should_respond=True,
            )
        )


def build_ops_workflow(client) -> Workflow:
    """Build the Ops Review graph.

    Args:
        client: a ``FoundryChatClient`` shared by all three specialist sub-agents.

    Returns:
        A ``Workflow`` whose output is the compliance specialist's final decision.
        The caller wraps it with ``.as_agent()`` for hosting.
    """
    forecast = AgentExecutor(
        Agent(
            client=client,
            name="forecast",
            instructions=_load_instructions("forecast", "You are a grocery demand-forecast specialist."),
        )
    )
    inventory = AgentExecutor(
        Agent(
            client=client,
            name="inventory",
            instructions=_load_instructions("inventory", "You are a grocery inventory specialist."),
        )
    )
    compliance = AgentExecutor(
        Agent(
            client=client,
            name="compliance",
            instructions=_load_instructions(
                "compliance", "You are a grocery supplier & compliance specialist."
            ),
        )
    )

    dispatcher = DispatchToSpecialists(id="dispatcher")
    gate = ComplianceGate(id="compliance-gate")

    # dispatcher --(fan-out)--> [forecast, inventory] --(fan-in)--> gate --> compliance
    return (
        WorkflowBuilder(start_executor=dispatcher, output_from=[compliance])
        .add_fan_out_edges(dispatcher, [forecast, inventory])
        .add_fan_in_edges([forecast, inventory], gate)
        .add_edge(gate, compliance)
        .build()
    )
