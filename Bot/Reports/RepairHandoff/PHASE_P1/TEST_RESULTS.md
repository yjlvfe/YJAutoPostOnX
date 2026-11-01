# Phase P1 CriticalClosure Test Results Matrix

**Test Harness:** `/root/YJAutoPostOnX_ReportArchive/raw_sources/Bot_Reports/FinalEvidence/CriticalClosure-20261101-073430/TEST_RUNNER/run_suite.py`  
**Execution Environment:** Isolated network namespace (`unshare -Urn`), loopback interface only (`127.0.0.1`), synthetic mock HTTP server, synthetic SQLite state databases.  
**Total Tests:** 44 (38 CriticalClosure base + 6 new negative/companion tests)  
**Final Summary:** **44 PASS / 0 FAIL / 0 HARNESS_ERROR** (100% PASS RATE, 100% REPEATABILITY)  

---

## 1. Comprehensive Results Table: Baseline vs. Post-Fix

| # | Test Identifier | Suite | Test Scenario / Description | Baseline POSTs | Baseline Result | Post-Fix POSTs | Post-Fix Result | Final State | Behavior Verified |
|---|---|:---:|---|:---:|:---:|:---:|:---:|:---:|---|
| 1 | `A_SUCCESS` | A | Normal successful HTTP POST | 1 | **PASS** | 1 | **PASS** | N/A | Clean 200 OK single-shot send |
| 2 | `A_CONNECT_REFUSED` | A | Target port closed / unreachable | 0 | **PASS** | 0 | **PASS** | N/A | Pre-send connection failure fails safe (0 POSTs) |
| 3 | `A_CURL_FAILOVER` | A | Pre-send curl initialization failure | 1 | **PASS** | 1 | **PASS** | N/A | Safe fallback to httpx before byte transmission |
| 4 | `A_ACCEPT_DROP` | A | Server accepts POST body then drops socket | 2 | **FAIL** | 1 | **PASS** | N/A | Re-raises exception; zero secondary fallback POST |
| 5 | `A_DELAY` | A | Server delays response past 0.3s timeout | 2 | **FAIL** | 1 | **PASS** | N/A | Timeout propagates cleanly; zero secondary fallback POST |
| 6 | `A_INCOMPLETE` | A | Server sends truncated / incomplete HTTP response | 1 | **PASS** | 1 | **PASS** | N/A | Incomplete response handled cleanly |
| 7 | `B_SUCCESS` | B | Normal end-to-end publishing via Runner | 1 | **PASS** | 1 | **PASS** | `published` | Item published, quota incremented by 1 |
| 8 | `B_LOST_EMPTY` | B | Server drops connection; timeline query returns empty | 8 | **FAIL** | 1 | **PASS** | `ambiguous` | Quarantined in ambiguous; zero automated replay cycles |
| 9 | `B_RUNNER_REPLAY_ONLY` | B | Drop mode with transport replay disabled | 4 | **FAIL** | 1 | **PASS** | `ambiguous` | Runner retry loop eliminated; exactly 1 POST total |
| 10 | `E_MALFORMED` | E | Server drops POST; timeline returns malformed JSON | 8 | **FAIL** | 1 | **PASS** | `ambiguous` | Malformed GraphQL parsed safely as ambiguous |
| 11 | `E_PAGE2` | E | Server drops POST; candidate tweet on page 2 | 8 | **FAIL** | 1 | **PASS** | `published` | Authentic recovery on page 2 via cursor traversal |
| 12 | `E_PAGE2_CORRECTED` | E | Corrected page 2 candidate fixture | 8 | **FAIL** | 1 | **PASS** | `published` | Cursor traversal supported; verified from timeline |
| 13 | `E_PREFIX` | E | Timeline tweet matches 40 chars; different body, no date | 2 | **FAIL** | 1 | **PASS** | `ambiguous` | Prefix match rejected; zero false publication/quota |
| 14 | `E_PREFIX_DATED` | E | Timeline tweet matches 40 chars with valid date | 2 | **FAIL** | 1 | **PASS** | `ambiguous` | Exact text match required; false positive eliminated |
| 15 | `E_NODATE` | E | Timeline tweet has identical text but missing date | 2 | **FAIL** | 1 | **PASS** | `ambiguous` | Missing date fails recency check closed |
| 16 | `E_WRONG_AUTHOR` | E | Timeline tweet has identical text but different user ID | 8 | **FAIL** | 1 | **PASS** | `ambiguous` | Author mismatch rejected; unconfirmed post kept ambiguous |
| 17 | `E_LATE_VISIBLE` | E | Tweet visibility delayed past initial check window | 8 | **FAIL** | 1 | **PASS** | `ambiguous` | Eventual consistency lag never triggers verifiedNotPosted |
| 18 | `C_BEFORE_POST` | C | Crash (SIGKILL) during claimed phase before dispatch | 1 | **PASS** | 1 | **PASS** | `published` | Pre-dispatch crash resets to pending; publishes on restart |
| 19 | `C_ACCEPTED` | C | Crash (SIGKILL) after server accepted POST | 1 | **PASS** | 1 | **PASS** | `ambiguous` | Post-dispatch crash recovers to ambiguous; 0 extra POST |
| 20 | `C_RESPONSE` | C | Crash (SIGKILL) during response parsing before SQLite write | 1 | **PASS** | 1 | **PASS** | `ambiguous` | Mid-response crash recovers to ambiguous; 0 extra POST |
| 21 | `C_PERSISTED` | C | Crash (SIGKILL) after atomic published + quota commit | 1 | **PASS** | 1 | **PASS** | `published` | State and quota preserved across crash and restart |
| 22 | `R_BEFORE_POST` | R | Recovery inspection: pre-dispatch crash | 1 | **PASS** | 1 | **PASS** | `published` | Recovers to pending then completes cleanly |
| 23 | `R_ACCEPTED` | R | Recovery inspection: post-dispatch crash | 1 | **PASS** | 1 | **PASS** | `ambiguous` | Durable ambiguous preserved on restart |
| 24 | `R_RESPONSE` | R | Recovery inspection: mid-response crash | 1 | **PASS** | 1 | **PASS** | `ambiguous` | Durable ambiguous preserved on restart |
| 25 | `R_PERSISTED` | R | Recovery inspection: post-commit crash | 1 | **PASS** | 1 | **PASS** | `published` | Quota 1 preserved; zero duplicate post |
| 26 | `Q_RACE` | C-QUEUE | 5 parallel workers attempt to claim same queue item | 0 | **PASS** | 0 | **PASS** | `processing` | Exactly 1 worker wins claim, 4 rejected cleanly |
| 27 | `Q_BUSY` | C-QUEUE | Competing worker attempts claim during held transaction | 0 | **PASS** | 0 | **PASS** | `processing` | Worker waits for lock release then succeeds |
| 28 | `Q_STALE` | C-QUEUE | Stale claim recovery after process timeout | 0 | **PASS** | 0 | **PASS** | `processing` | Stale generation recovered with new distinct token |
| 29 | `Q_CRASH_TX` | C-QUEUE | Crash during store mutation transaction | 0 | **PASS** | 0 | **PASS** | `processing` | Uncommitted transaction rolls back without quota loss |
| 30 | `Q_LATE_CALLBACK` | C-QUEUE | Delayed callback arrives after new token injected | 1 | **FAIL** | 0 | **PASS** | `processing` | Token fencing drops stale callback; new claim intact |
| 31 | `IPC_OK` | D | Standard JSON-lines IPC protocol handshake | 0 | **PASS** | 0 | **PASS** | N/A | Child cleanly reaped; callback called exactly once |
| 32 | `IPC_INCOMPLETE` | D | Child process closes stdout prematurely | 0 | **PASS** | 0 | **PASS** | N/A | Incomplete IPC stream transitions to ambiguous |
| 33 | `IPC_TIMEOUT` | D | Child process hangs past timeout deadline | 0 | **PASS** | 0 | **PASS** | N/A | Child killed with SIGKILL; orphan prevented |
| 34 | `IPC_SIGTERM` | D | External SIGTERM sent to child process | 0 | **PASS** | 0 | **PASS** | N/A | Child reaped cleanly; uncertain result fenced ambiguous |
| 35 | `IPC_SIGKILL` | D | External SIGKILL sent to child process | 0 | **PASS** | 0 | **PASS** | N/A | Process tree cleaned up; result fenced ambiguous |
| 36 | `IPC_LATE_CALLBACK` | D | Delayed callback simulation | 0 | **PASS** | 0 | **PASS** | N/A | Callback dispatched correctly once; child closed |
| 37 | `IPC_LATE_RESULT` | D | Result emitted after child timeout | 0 | **PASS** | 0 | **PASS** | N/A | Stale result discarded; timeout ambiguous preserved |
| 38 | `IPC_LATE_READY` | D | Readiness event arrives after timeout | 0 | **PASS** | 0 | **PASS** | N/A | No false ACK dispatched; child killed cleanly |
| 39 | `E_PAGE2_EMPTY` | E | Server drops POST; page 2 timeline returns empty | — | *New Test* | 1 | **PASS** | `ambiguous` | Strictly asserts ambiguous when page 2 lacks tweet (R3) |
| 40 | `E_URL_DIFF` | E | Tweet text has different URL than timeline tweet | — | *New Test* | 1 | **PASS** | `ambiguous` | Different URLs rejected; fails closed without match (R1) |
| 41 | `E_URL_MATCH` | E | Tweet text has identical URL to timeline tweet | — | *New Test* | 1 | **PASS** | `published` | Exact canonical URL match confirms publication (R1) |
| 42 | `E_URL_SHORTENED` | E | Tweet has t.co link expanded via entities to target URL | — | *New Test* | 1 | **PASS** | `published` | Entity-expanded t.co link validates match (R1) |
| 43 | `Q_STALE_SUCCESS_PATH` | C-QUEUE | Delayed success callback arriving during newer attempt | — | *New Test* | 0 | **PASS** | `processing` | Stale success rejected by token fence; active claim intact (R2) |
| 44 | `Q_STALE_EXCEPTION_PATH` | C-QUEUE | Delayed exception callback arriving during newer attempt | — | *New Test* | 0 | **PASS** | `processing` | Stale exception rejected; active claim and lock intact (R2) |

---

## 2. Key Metrics Comparison

| Metric | Preliminary Baseline | Corrected Baseline | Post-Fix (Iteration 3) | Delta / Impact |
|---|:---:|:---:|:---:|:---:|
| **Total Test Cases** | 38 | 38 | **44** | +6 comprehensive negative/companion tests |
| **Passing Tests** | 24 | 25 | **44** | **100% PASS RATE** |
| **Failing Tests** | 14 | 13 | **0** | **-100% defects** |
| **Harness Errors** | 0 | 0 | **0** | Clean isolated execution |
| **Duplicate POST Transmissions** | Observed in 6 scenarios (up to 8 POSTs) | Observed in 6 scenarios | **0 duplicate POSTs** across all scenarios | Complete elimination of duplicate publishing |
| **Attempt Token Protection** | Stale callbacks could clear lock / mutate items | Stale callbacks could clear lock | **100% Protected** across success, error, finally & crash | Zero race window on delayed dispatches |
| **Repeatability** | Dirty runs failed 24 tests | Dirty runs failed 24 tests | **100% Repeatable** | Consecutive runs produce 44 PASS / 0 FAIL |

---

## 3. Resolution of Baseline Discrepancy (24/14 Preliminary vs. 25/13 Product Baseline)

- **The Discrepancy**: Preliminary narrative summaries (`PROGRESS_HISTORY.md:4`, early draft of `TEST_RESULTS.md`) stated "24 PASS, 14 FAIL", whereas the itemized baseline results table recorded 25 PASS and 13 FAIL.
- **Root Cause & Forensic Proof**:
  - In the initial unadjusted baseline execution (`EVIDENCE/suite.stdout:18`, `EVIDENCE/Q_CRASH_TX_INITIAL/result.json`), `Q_CRASH_TX` failed because the test worker exited cleanly (`exit_code: 0`) before the test runner could issue `SIGKILL`. Node.js does not keep its event loop alive on an unresolved Promise alone. This produced 14 failures and 24 passes.
  - As documented in `EXECUTION_LOG.md:15`, this was an artifact of the test harness worker keepalive, NOT a product defect. A `setInterval` keepalive was added to `node_worker.js:crashTransaction()`, and `Q_CRASH_TX` was rerun, passing cleanly (`killed: -9`, `assertion_result: PASS`).
  - Therefore, the true product baseline is **25 PASS and 13 true product defects**. The 24/14 metric reflected the initial unadjusted preliminary run before the harness keepalive fix. Both numbers are historically valid in their respective contexts, and documenting this explicitly clears all ambiguity.

---

## 4. Standalone Proofs & Targeted Verification

### 4.1 Independent Proof for P1-004: Deduplication & Atomic Claim Fencing (`scripts/verify_p1_004_dedup.js`)
- **Execution**: Standalone script executing directly against `Bot/src/queue.js` and `Bot/src/runner.js` with isolated SQLite storage.
- **Results**:
  - `Queue.enqueue()`: 5 payloads submitted with 2 duplicate payloads $\rightarrow$ exactly 3 admitted, 2 rejected via SHA-256 content hashing (**PASS**).
  - `Queue.replacePending()`: Deduplication verified (**PASS**).
  - Atomic Claim Fencing: 5 concurrent asynchronous worker promises attempt to claim the same pending item $\rightarrow$ exactly 1 worker acquires the claim (`claimed: true`) and 4 workers receive `{ claimed: false }` (**PASS**).

### 4.2 Independent Proof for P1-005: Non-Blocking Queue Continuation (`scripts/verify_p1_005_queue_flow.js`)
- **Execution**: Standalone script executing `runner.run()` with 3 items where Item 1 and Item 2 fail into `ambiguous` states.
- **Results**:
  - Item 1 drops $\rightarrow$ quarantined as `ambiguous`.
  - Item 2 drops $\rightarrow$ quarantined as `ambiguous`.
  - Item 3 succeeds $\rightarrow$ published with valid URL and quota incremented to 1.
  - Cycle completes in < 250ms, confirming `skipDelay = true` bypassed delay loops and prevented queue stall (**PASS**).

### 4.3 URL Canonicalization & Entity Expansion Unit Tests (`Bot/python/test_normalize_urls.py`)
- **Execution**: `unshare -Urn` execution of 14 unit test scenarios.
- **Results**:
  - Rejection of mismatched URLs (**PASS**).
  - Matching of identical URLs (**PASS**).
  - Matching of entity-expanded `t.co` URLs (**PASS**).
  - Rejection of unmapped `t.co` URLs (fails closed to ambiguous) (**PASS**).
  - Canonicalization invariance (port 80/443, trailing slash, casing) (**PASS**).
  - Total: **14/14 tests PASS in 12.0s**.

### 4.4 Runner Race Condition Reproduction (`test_reproduction.js`)
- **Execution**: Evaluated across success path, exception path, and crash path.
- **Results**:
  - Check 1: Late success callback cannot clear active attempt's publishing lock (**PASS**).
  - Check 2: Late success callback cannot mutate active attempt state (**PASS**).
  - Check 3: Late exception callback cannot clear active attempt's publishing lock (**PASS**).
  - Check 4: Late exception callback cannot mark active attempt ambiguous (**PASS**).
  - Check 5: Late crash callback cannot clear active attempt's publishing lock (**PASS**).
  - Check 6: Late crash callback cannot reset active attempt to pending (**PASS**).
