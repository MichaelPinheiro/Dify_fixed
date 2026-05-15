#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker command not found in PATH."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yaml}"
GRAPHON_WHEEL_URL="${GRAPHON_WHEEL_URL:-https://files.pythonhosted.org/packages/de/89/a6340afdaf5169d17a318e00fc685fb67ed99baa602c2cbbbf6af6a76096/graphon-0.2.2-py3-none-any.whl}"
SERVICES=(api worker worker_beat)

diagnose_service() {
  local service="$1"
  echo "=== ${service}: runtime check ==="
  sudo docker compose -f "${COMPOSE_FILE}" exec -T "${service}" /app/api/.venv/bin/python - <<'PY'
import inspect
import sys
import graphon
from graphon.nodes.llm.node import LLMNode

print("python_executable =", sys.executable)
print("graphon_module    =", graphon.__file__)
print("node_source       =", inspect.getsourcefile(LLMNode))
handle_src = inspect.getsource(LLMNode.handle_invoke_result)
stream_src = inspect.getsource(LLMNode._yield_streaming_invoke_result)
print("has_fix_handle    =", "collected_structured_output" in handle_src)
print("has_fix_streaming =", "collected_structured_output" in stream_src)
print("has_compat_fallback =", "candidate_text = clean_text.strip()" in inspect.getsource(LLMNode._yield_run_completion))
PY
  echo
}

sync_node_source_service() {
  local service="$1"
  echo "=== ${service}: sync node.py from canonical wheel ==="
  sudo docker compose -f "${COMPOSE_FILE}" exec -T --user root \
    -e GRAPHON_WHEEL_URL="${GRAPHON_WHEEL_URL}" \
    "${service}" /app/api/.venv/bin/python - <<'PY'
import inspect
import io
import os
import urllib.request
import zipfile

from graphon.nodes.llm.node import LLMNode

wheel_url = os.environ["GRAPHON_WHEEL_URL"]
node_path = inspect.getsourcefile(LLMNode)

if not node_path:
    raise RuntimeError("Could not resolve graphon node.py path.")

with open(node_path, "r", encoding="utf-8") as f:
    current = f.read()

patched = current
did_sync_streaming_fix = False
did_apply_compat_fix = False

if "collected_structured_output" not in patched:
    print(f"Downloading canonical wheel from: {wheel_url}")
    wheel_bytes = urllib.request.urlopen(wheel_url, timeout=30).read()  # noqa: S310
    with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as zf:
        canonical = zf.read("graphon/nodes/llm/node.py").decode("utf-8")

    if "collected_structured_output" not in canonical:
        raise RuntimeError("Canonical wheel node.py does not contain collected_structured_output.")

    start_marker = "    @staticmethod\n    def _yield_streaming_invoke_result("
    end_marker = "\n    @staticmethod\n    def _update_streaming_metadata("

    current_start = patched.find(start_marker)
    current_end = patched.find(end_marker, current_start)
    canonical_start = canonical.find(start_marker)
    canonical_end = canonical.find(end_marker, canonical_start)

    if min(current_start, current_end, canonical_start, canonical_end) == -1:
        raise RuntimeError("Could not locate streaming function markers in node.py.")

    replacement_block = canonical[canonical_start:canonical_end]
    patched = patched[:current_start] + replacement_block + patched[current_end:]
    did_sync_streaming_fix = True

# Compatibility fix:
# 1) preserve empty-dict structured output (avoid false-y drop)
# 2) fallback parse from clean_text when event.structured_output is None
needle = """            if event.structured_output:
                structured_output = LLMStructuredOutput(
                    structured_output=event.structured_output,
                )
            break
"""

replacement = """            if event.structured_output is not None:
                structured_output = LLMStructuredOutput(
                    structured_output=event.structured_output,
                )
            elif clean_text:
                candidate_text = clean_text.strip()
                if candidate_text.startswith(\"```\"):
                    candidate_text = re.sub(r\"^```(?:json)?\\\\s*\", \"\", candidate_text, flags=re.IGNORECASE)
                    candidate_text = re.sub(r\"\\\\s*```$\", \"\", candidate_text)
                try:
                    parsed_structured_output = json.loads(candidate_text)
                except Exception:
                    parsed_structured_output = None
                if isinstance(parsed_structured_output, dict):
                    structured_output = LLMStructuredOutput(
                        structured_output=parsed_structured_output,
                    )
            break
"""

if needle in patched and "candidate_text = clean_text.strip()" not in patched:
    patched = patched.replace(needle, replacement, 1)
    did_apply_compat_fix = True

if patched != current:
    with open(node_path, "w", encoding="utf-8") as f:
        f.write(patched)
    print(f"Patched node.py at: {node_path}")
else:
    print("node.py already up to date.")

print(f"streaming_fix_synced={did_sync_streaming_fix} compat_fix_applied={did_apply_compat_fix}")
PY
  echo
}

install_service() {
  local service="$1"
  echo "=== ${service}: reinstall graphon wheel ==="
  sudo docker compose -f "${COMPOSE_FILE}" exec -T --user root \
    -e GRAPHON_WHEEL_URL="${GRAPHON_WHEEL_URL}" \
    "${service}" /bin/bash -lc '
set -euo pipefail
PY="/app/api/.venv/bin/python"

if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "pip not found in /app/api/.venv; attempting bootstrap with ensurepip..."
  if "$PY" -m ensurepip --upgrade >/dev/null 2>&1; then
    echo "ensurepip succeeded."
  else
    echo "ensurepip unavailable. Trying uv fallback..."
    if command -v uv >/dev/null 2>&1; then
      uv pip install --python "$PY" --no-deps --reinstall "$GRAPHON_WHEEL_URL"
      exit 0
    fi
    echo "ERROR: could not bootstrap pip and uv is not available."
    exit 1
  fi
fi

"$PY" -m pip install --no-cache-dir --no-deps --force-reinstall "$GRAPHON_WHEEL_URL"
'
  echo
}

echo "Checking current state..."
for service in "${SERVICES[@]}"; do
  diagnose_service "${service}"
done

echo "Applying graphon fix on api/worker/worker_beat..."
for service in "${SERVICES[@]}"; do
  install_service "${service}"
  sync_node_source_service "${service}"
done

echo "Restarting api, worker and worker_beat..."
sudo docker compose -f "${COMPOSE_FILE}" restart api worker worker_beat >/dev/null
sleep 5

echo "Checking final state..."
for service in "${SERVICES[@]}"; do
  diagnose_service "${service}"
done

echo "Done. Expected result: has_fix_streaming = True on api and worker."
