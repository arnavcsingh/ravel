#!/usr/bin/env bash
# Run from Linux, or: wsl -d Ubuntu-22.04 -- bash benchmarks/asyncodebench.sh check
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.ravel/benchmark-source"
export ASYNCODEBENCH_ROOT="$TOOLS/AsynCodeBench"
export UV_CACHE_DIR="$TOOLS/cache"
export UV_PYTHON_INSTALL_DIR="$TOOLS/python"
export LITELLM_LOCAL_MODEL_COST_MAP=True
RUNNER="$ASYNCODEBENCH_ROOT/reproductions/async-swe-agents"
REVISION=566c32b6f4ad209ecfe95f10970b02d4b79289c1
UV="${RAVEL_UV:-$TOOLS/bin/uv}"
action="${1:-check}"
if [[ $# -gt 0 ]]; then shift; fi
export SDK_SOURCE_DIR="$ASYNCODEBENCH_ROOT/reproductions/software-agent-sdk"

if [[ ! -x "$UV" ]]; then
  echo 'uv is missing. Set RAVEL_UV to an installed uv executable.' >&2
  exit 2
fi
# The SDK invokes `uv build` itself while constructing its Docker image.
export PATH="$(dirname "$UV"):$PATH"
if [[ "$action" == setup ]]; then
  if [[ ! -d "$ASYNCODEBENCH_ROOT/.git" ]]; then
    git clone https://github.com/KaituoZhang/AsynCodeBench.git "$ASYNCODEBENCH_ROOT"
    git -C "$ASYNCODEBENCH_ROOT" checkout --detach "$REVISION"
  fi
fi
if [[ "$(git -C "$ASYNCODEBENCH_ROOT" rev-parse HEAD)" != "$REVISION" ]]; then
  echo 'Benchmark revision differs from the inspected pin; refusing to change it automatically.' >&2
  exit 2
fi
export PYTHONPATH="$RUNNER:$ASYNCODEBENCH_ROOT/src"
case "$action" in
  setup)
    "$UV" python install 3.12
    "$UV" venv --python 3.12 --allow-existing "$TOOLS/validation-env"
    "$UV" pip install --python "$TOOLS/validation-env/bin/python" 'jsonschema>=4.23,<5' 'pydantic>=2.7,<3' 'pytest>=8.3,<9'
    "$TOOLS/validation-env/bin/python" "$ASYNCODEBENCH_ROOT/scripts/materialize_openhands_sdk.py" --require-clean
    "$UV" sync --frozen --extra dev --python 3.12 --project "$RUNNER"
    ;;
  check)
    PYTHON="$TOOLS/validation-env/bin/python"
    "$PYTHON" -m asyncodebench_harness.cli release-status --require preview
    "$PYTHON" -m asyncodebench_harness.cli tasks
    "$PYTHON" -m pytest -q "$ASYNCODEBENCH_ROOT/tests/contracts/test_v04_release_bundle.py" "$ASYNCODEBENCH_ROOT/tests/contracts/test_result_admission.py"
    ;;
  dry-run)
    cd "$RUNNER"
    "$UV" run --frozen --no-sync asyncodebench run --release v0.4 --task asyncodebench:cachetools --protocol all --model test/no-model-call --dry-run
    ;;
  runner-check)
    "$RUNNER/.venv/bin/python" "$ASYNCODEBENCH_ROOT/scripts/check_openhands_runtime_consistency.py" --require-clean
    "$RUNNER/.venv/bin/python" -m pytest -q "$RUNNER/tests/test_agent_adapter_contract.py" "$RUNNER/tests/test_cli_doctor.py"
    "$RUNNER/.venv/bin/python" "$ASYNCODEBENCH_ROOT/scripts/smoke_openhands_event_roundtrip.py"
    ;;
  smoke)
    # This upstream diagnostic adapter intentionally cannot solve the task.
    # It makes no model calls; evaluator failure is expected, infrastructure failure is not.
    export LLM_API_KEY=diagnostic-no-model-calls
    export LLM_BASE_URL=http://127.0.0.1:1
    if ! timeout 20 docker info; then
      echo 'Docker is unavailable in this Linux environment. Start Docker Desktop and enable integration for this WSL distro, then retry smoke.' >&2
      exit 2
    fi
    cd "$RUNNER"
    "$UV" run --frozen --no-sync asyncodebench run --release v0.4 --task asyncodebench:cachetools --protocol single --model test/no-model-call --agent-import-path examples.agents.diagnostic_adapter:DiagnosticAgentAdapter --output-dir "$TOOLS/smoke-$(date -u +%Y%m%dT%H%M%S)"
    ;;
  doctor)
    cd "$RUNNER"
    "$UV" run --frozen --no-sync asyncodebench doctor
    ;;
  run)
    if ! timeout 20 docker info >/dev/null; then
      echo 'Docker is unavailable. Start Docker Desktop with WSL integration.' >&2
      exit 2
    fi
    cd "$RUNNER"
    "$UV" run --frozen --no-sync asyncodebench run --release v0.4 --model "$LLM_MODEL" --output-dir "$TOOLS/native-$(date -u +%Y%m%dT%H%M%S)" "$@"
    ;;
  *) echo 'Usage: asyncodebench.sh setup|check|runner-check|dry-run|smoke|doctor|run' >&2; exit 2 ;;
esac
