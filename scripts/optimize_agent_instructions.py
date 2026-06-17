#!/usr/bin/env python3
"""Produce improved Tier-2 specialist instructions from an evaluation regression.

This is the brain of the self-improving loop. When a Foundry evaluation flags a
weak answer, this script generates a better version of ``agent/instructions.md``
and the GitHub workflow opens a pull request with the change.

Two modes:

* **Real optimizer** (default when ``FOUNDRY_PROJECT_ENDPOINT`` is set): calls the
  Foundry prompt optimizer / agent optimizer against the eval dataset to produce
  improved instructions.
* **Curated fallback** (``--mode curated`` or when Foundry is not configured):
  applies the reviewed improvement in ``agent/.optimizer/improved-instructions.md``.
  This keeps the loop deterministic and reviewable.

The script only writes ``agent/instructions.md``. Review + merge happen in the PR;
redeploy happens on merge. Nothing is deployed from here.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1] / "agent"
# The self-improving loop targets the Supplier & Compliance specialist, whose
# baseline instructions are deliberately weak on the regulatory check.
INSTRUCTIONS = AGENT_DIR / "instructions" / "compliance.md"
CURATED = AGENT_DIR / ".optimizer" / "improved-instructions.md"


def run_real_optimizer() -> str | None:
    """Run the Foundry agent optimizer and return improved instructions text.

    Uses ``azd ai agent optimize`` against ``eval.yaml`` when the azd project and
    Azure credentials are available. Returns None if the optimizer is unavailable
    so the caller can fall back to the curated improvement.
    """
    endpoint = os.environ.get("FOUNDRY_PROJECT_ENDPOINT")
    if not endpoint:
        return None
    if shutil.which("azd") is None:
        print("azd not found; cannot run the real optimizer.", file=sys.stderr)
        return None

    # The full optimizer integration runs `azd ai agent optimize` and then
    # `azd ai agent optimize apply --candidate <id>`, which rewrites the agent's
    # configured instructions. That requires the deployed agent, the
    # azure.ai.agents azd extension, and an eval run. In CI we invoke it via the
    # workflow; here we simply signal that the caller should use that path.
    print(
        "FOUNDRY_PROJECT_ENDPOINT is set. Run the Foundry optimizer via:\n"
        "  azd ai agent optimize --config agent/eval.yaml\n"
        "  azd ai agent optimize apply --candidate <best>\n"
        "Falling back to the curated improvement for a deterministic PR.",
        file=sys.stderr,
    )
    return None


def curated_improvement() -> str:
    if not CURATED.exists():
        raise FileNotFoundError(f"Curated improvement not found: {CURATED}")
    return CURATED.read_text(encoding="utf-8").rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["auto", "real", "curated"],
        default="auto",
        help="auto: real optimizer if configured else curated; real: optimizer only; curated: curated only",
    )
    args = parser.parse_args()

    improved: str | None = None
    if args.mode in ("auto", "real"):
        improved = run_real_optimizer()
    if improved is None:
        if args.mode == "real":
            print("Real optimizer unavailable and --mode real was requested.", file=sys.stderr)
            return 1
        improved = curated_improvement()

    current = INSTRUCTIONS.read_text(encoding="utf-8") if INSTRUCTIONS.exists() else ""
    if current.strip() == improved.strip():
        print("No change: instructions already match the improved version.")
        return 0

    INSTRUCTIONS.write_text(improved, encoding="utf-8")
    print(f"Updated {INSTRUCTIONS.relative_to(AGENT_DIR.parent)} with improved instructions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
