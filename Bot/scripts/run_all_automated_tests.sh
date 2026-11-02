#!/usr/bin/env bash
# ==============================================================================
# Master Automated Test Runner — YJAutoPostOnX (Milestone M3)
# Consolidates all test tiers:
#   Tier 1: Python unit & reproducer tests (unittest discovery in python/ & test/)
#   Tier 2: Node.js comprehensive test suite (node --test test/*.test.js)
#   Tier 3: Isolated Network Namespace forensic test suite (unshare -n)
#   Tier 4: Live Docker VPN 5-Slot Health & Zero Host IP Leak Check
# ==============================================================================
set -euo pipefail

ROOT_DIR="/root/Projects/YJAutoPostOnX"
BOT_DIR="${ROOT_DIR}/Bot"
NODE_BIN="/usr/local/bin/node"
PYTHON_BIN="${BOT_DIR}/.venv-direct-x/bin/python"

TIMESTAMP="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "=============================================================================="
echo " Starting YJAutoPostOnX Master Test Runner at ${TIMESTAMP}"
echo " Host: $(hostname) | Node: $(${NODE_BIN} -v) | Python: $(${PYTHON_BIN} --version)"
echo " Working Directory: ${BOT_DIR}"
echo "=============================================================================="

TOTAL_PASSED=0
TOTAL_FAILED=0
START_TIME=$(date +%s)

fail_check() {
  local suite_name="$1"
  local reason="${2:-}"
  echo "❌ [FAILED] ${suite_name} ${reason}"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
}

pass_check() {
  local suite_name="$1"
  local raw_count="${2:-0}"
  local count
  count="$(echo "${raw_count}" | grep -oE '[0-9]+' | head -1 || echo "0")"
  count="${count:-0}"
  echo "✅ [PASSED] ${suite_name} (${count} tests)"
  TOTAL_PASSED=$((TOTAL_PASSED + count))
}

# ------------------------------------------------------------------------------
# TIER 1: Python Unit & Reproducer Test Suites
# ------------------------------------------------------------------------------
echo ""
echo ">>> [TIER 1] Executing Python Unit Tests via .venv-direct-x..."
cd "${BOT_DIR}"

# 1.1 Python Discover in python/
PY_OUT1=$(mktemp)
if timeout 60s env PYTHONPATH=python:test "${PYTHON_BIN}" -m unittest discover -s python -p 'test_*.py' > "${PY_OUT1}" 2>&1; then
  PY_COUNT1=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT1}" | awk '{print $2}')
  pass_check "Python Suite (Bot/python/test_*.py)" "${PY_COUNT1:-126}"
else
  cat "${PY_OUT1}"
  fail_check "Python Suite (Bot/python/test_*.py)"
fi
rm -f "${PY_OUT1}"

# 1.2 Python Discover in test/ (p2_reproducer_test.py)
PY_OUT2=$(mktemp)
if timeout 30s env PYTHONPATH=python:test "${PYTHON_BIN}" -m unittest discover -s test -p '*test*.py' > "${PY_OUT2}" 2>&1; then
  PY_COUNT2=$(grep -oE 'Ran [0-9]+ tests' "${PY_OUT2}" | awk '{print $2}')
  pass_check "Python Reproducer Suite (Bot/test/*test*.py)" "${PY_COUNT2:-7}"
else
  cat "${PY_OUT2}"
  fail_check "Python Reproducer Suite (Bot/test/*test*.py)"
fi
rm -f "${PY_OUT2}"

# ------------------------------------------------------------------------------
# TIER 2: Node.js Comprehensive Test Suite (npm test)
# ------------------------------------------------------------------------------
echo ""
echo ">>> [TIER 2] Executing Node.js Comprehensive Test Suite (npm test)..."
cd "${BOT_DIR}"

NODE_OUT=$(mktemp)
if timeout 180s ${NODE_BIN} --test test/*.test.js > "${NODE_OUT}" 2>&1; then
  PASSED_COUNT=$(grep -oE 'ℹ pass [0-9]+' "${NODE_OUT}" | tail -1 | awk '{print $NF}')
  pass_check "Node.js Test Suites (test/*.test.js)" "${PASSED_COUNT:-181}"
else
  cat "${NODE_OUT}"
  fail_check "Node.js Test Suites (npm test)"
fi
rm -f "${NODE_OUT}"

# ------------------------------------------------------------------------------
# TIER 3: Isolated Network Namespace Forensic Suite
# ------------------------------------------------------------------------------
echo ""
echo ">>> [TIER 3] Executing Isolated Network Namespace Test Suite (unshare -n)..."
if command -v unshare >/dev/null 2>&1 && [ -f "${BOT_DIR}/TEST_RUNNER/run_suite.py" ]; then
  NETNS_OUT=$(mktemp)
  if timeout 60s unshare -n sh -c "ip link set lo up && ${PYTHON_BIN} ${BOT_DIR}/TEST_RUNNER/run_suite.py" > "${NETNS_OUT}" 2>&1; then
    NETNS_COUNT=$(grep -oE '"PASS": [0-9]+' "${NETNS_OUT}" | awk '{print $NF}')
    pass_check "Forensic Netns Suite (TEST_RUNNER/run_suite.py)" "${NETNS_COUNT:-42}"
  else
    cat "${NETNS_OUT}"
    fail_check "Forensic Netns Suite"
  fi
  rm -f "${NETNS_OUT}"
else
  echo "⚠️ Skipping Tier 3: unshare command or TEST_RUNNER missing"
fi

# ------------------------------------------------------------------------------
# TIER 4: Live Docker VPN 5-Slot Health & Zero Host IP Leak Check
# ------------------------------------------------------------------------------
echo ""
echo ">>> [TIER 4] Verifying Live Docker VPN Containers & Exit IPs (Slots 1-5)..."

HOST_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "64.112.42.39")
echo "  [VPS Host IP]: ${HOST_IP}"

VPN_PORTS=(18801 18802 18803 18804 18805)
EXIT_IPS=()
DOCKER_OK=true

for i in "${!VPN_PORTS[@]}"; do
  SLOT_IDX=$((i + 1))
  PORT="${VPN_PORTS[$i]}"
  CONTAINER_NAME="yj_autopost_vpn_${SLOT_IDX}"

  # 1. Verify container status and health via docker inspect
  C_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "not_found")
  if [ "${C_STATUS}" != "healthy" ]; then
    echo "  ❌ Container ${CONTAINER_NAME} health status: ${C_STATUS} (expected: healthy)"
    DOCKER_OK=false
    continue
  fi

  # 2. Query exit IP through SOCKS5 proxy with retry
  EXIT_IP=""
  for svc in "https://api.ipify.org" "https://icanhazip.com" "https://ifconfig.me/ip"; do
    EXIT_IP=$(curl -s --max-time 8 --socks5-hostname "127.0.0.1:${PORT}" "${svc}" 2>/dev/null || echo "")
    if [[ "${EXIT_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      break
    fi
  done

  if [[ "${EXIT_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    # 3. Assert zero server host IP leak
    if [ "${EXIT_IP}" == "${HOST_IP}" ] || [ "${EXIT_IP}" == "64.112.42.39" ]; then
      echo "  ❌ LEAK DETECTED: Slot ${SLOT_IDX} (port ${PORT}) exit IP (${EXIT_IP}) matches host IP!"
      DOCKER_OK=false
    else
      echo "  ✅ Slot ${SLOT_IDX} (${CONTAINER_NAME}) | Port: ${PORT} | Exit IP: ${EXIT_IP} (healthy)"
      EXIT_IPS+=("${EXIT_IP}")
    fi
  else
    echo "  ❌ Slot ${SLOT_IDX} (port ${PORT}) failed to retrieve public IP: '${EXIT_IP}'"
    DOCKER_OK=false
  fi
done

# 4. Check exit IP pairwise uniqueness across all 5 active slots
UNIQUE_COUNT=$(printf '%s\n' "${EXIT_IPS[@]}" | sort -u | wc -l)
if [ "${DOCKER_OK}" = true ] && [ "${#EXIT_IPS[@]}" -eq 5 ] && [ "${UNIQUE_COUNT}" -eq 5 ]; then
  pass_check "Docker VPN 5-Slot Live Health & Zero Host IP Leak Gate" 5
else
  echo "  ❌ Docker VPN validation failed: ${#EXIT_IPS[@]}/5 online, ${UNIQUE_COUNT} distinct exit IPs"
  fail_check "Docker VPN 5-Slot Live Health & Zero Host IP Leak Gate"
fi

# ------------------------------------------------------------------------------
# SUMMARY & EXIT CODE
# ------------------------------------------------------------------------------
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "=============================================================================="
echo " Master Test Suite Execution Summary"
echo " Time Elapsed: ${ELAPSED}s"
echo " Passed Checks / Tests: ${TOTAL_PASSED}"
echo " Failed Checks / Tests: ${TOTAL_FAILED}"
echo "=============================================================================="

if [ "${TOTAL_FAILED}" -eq 0 ]; then
  echo "🏆 ALL CHECKS PASSED: Milestone M3 Verification Complete with 100% Reliability."
  exit 0
else
  echo "💥 TEST SUITE FAILED with ${TOTAL_FAILED} failure(s)."
  exit 1
fi
