# YJAutoPostOnX — ADD-ONLY gap register for original P1–P6 plan

**Date:** 2026-11-03 | **Source:** original user-uploaded TODO v1.2 (2026-11-01) + GitHub source and reports through PR #19.

## Invariants
- Historical original: **33 findings** across P1(5), P2(4), P3(10), P4(9), P5(3), P6(2). **DO NOT rewrite, reclassify, or convert original records**.
- This file contains **20 new follow-ups**, separately named `ADD-Px-xx`; they do not become new original FINDING IDs.
- GitHub's M1–M11 labels are test/production rounds, **not replacements** for P1–P6. GitHub MASTER_TODO has a different internal phase taxonomy; do not overwrite the source's P1–P6 taxonomy.
- Implementation, test evidence, Codex signoff, and owner-production acceptance are separate fields. **All 33 original Codex approvals remain PENDING**, as do approval gates for these new tasks.
- The figure **~30 ambiguous** is from the last owner screenshot, not a fresh live SQLite query. Never auto-requeue post-dispatch ambiguous items without authoritative evidence.
- The main branch verified here: `e8a367bccd966b9f42b20703f4012794ac693e3e` (PR #21, PR #22, PR #23, PR #24, and PR #25 merged; GitHub CI success, full test suites PASS).

## Additional work by ORIGINAL P phase

### P1 — 4 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P1-01` | جرد جميع المنشورات الغامضة (~30 في آخر لوحة) وتصنيف مصير كل itemId دون إعادة جماعية | `AUDITED_QUARANTINED` | `PASS` | دليل حالة كل عنصر + إرجاع ذري لـ 4 استردادات خاطئة + 30/30 محجوزة بلا إعادة نشر |
| `ADD-P1-02` | تمييز رفض GraphQL المؤكد من نتيجة ما بعد dispatch غير المحسومة | `MERGED_PR21` | `PASS` | إثبات سياسة إعادة/حجر آمنة دون POST مكرر |
| `ADD-P1-03` | قياس جميع محاولات النشر لا الناجحة فقط وربط الفشل بالكوتا والطابور | `MERGED` | `LIVE_EVIDENCE_PARTIAL` | محاولات=ناجح+فاشل+غامض لكل دورة وحساب؛ دون ازدواج عد |
| `ADD-P1-04` | التحقق الممتد من سياج rate_limit بعد dispatch وتأكيدات النشر المتأخرة | `MERGED` | `LOCAL_REGRESSION_PASS_VPS_PENDING` | لا إعادة pending بعد إرسال غير محسوم |

### P2 — 3 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P2-01` | مزامنة لوحتي تيليجرام وإشعار مصدر بدء التشغيل والتوقف بصدق | `MERGED` | `LIVE_EVIDENCE_REPORTED` | runId + messageId وإشعارات فعلية لزر/جدولة |
| `ADD-P2-02` | قياس البطء بمراحل Telegram/Event Loop/SQLite/Direct X دون تغيير الوتيرة افتراضًا | `MERGED` | `LIVE_EVIDENCE_PARTIAL` | معرفة مكان الاختناق بأرقام قياس؛ سرعة ticker الأصلية |
| `ADD-P2-03` | تأكيد stop الطبيعي واليدوي وتسليم CSV للشاتين بإيصالات | `MERGED` | `LIVE_EVIDENCE_REPORTED` | حفظ terminal receipts من المصدر الحقيقي |

### P3 — 3 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P3-01` | قراءة SQLite دون حجز الكاتب وقياس latency والتنافس | `MERGED` | `LIVE_EVIDENCE_REPORTED` | BEGIN deferred للقراءة واختبار تزامن عمليات SQLite |
| `ADD-P3-02` | تشخيص دائم لكل item وربط المحاولات السابقة حتى بعد تصفير الضربات | `PARTIAL_MERGED` | `VPS_E2E_PENDING` | failureDiagnostic + runId + attemptId + audit trail |
| `ADD-P3-03` | اختبار تحمل طويل بعد أدوار كثيرة وإعادة تشغيل بدون بوت ثانٍ | `PARTIAL_LIVE_EVIDENCE` | `FURTHER_ENDURANCE_PENDING` | دوارات ممتدة ومراقبة الموارد وسلامة الطابور |

### P4 — 4 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P4-01` | منع Twikit KeyError 'urls' في CreateTweet وقراءة Timeline | `MERGED` | `LIVE_EVIDENCE_REPORTED` | حسابات البايو الفارغ تنشر بلا انهيار |
| `ADD-P4-02` | نقل أكواد ورسائل GraphQL/HTTP وكشف خطأ التحقق من Python إلى Node وSQLite | `MERGED_PR21` | `PASS` | أسباب X الأصلية لكل فشل دون أسرار في اللوج |
| `ADD-P4-03` | عدم احتساب رفض المحتوى 186/187 كضربة حساب ومراجعة تبعات 3-strikes | `MERGED_PR19` | `CI_GREEN_VPS_E2E_PENDING` | اختبار حدود رفض المحتوى/الحظر/التهدئة |
| `ADD-P4-04` | استقرار 5 حاويات VPN وعدم تسرب IP والـrotate خلال التشغيل الطويل | `IMPLEMENTED_HISTORICALLY` | `LIVE_EVIDENCE_REPORTED` | اختبارات عزل واتصال واستقرار على VPS |

### P5 — 2 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P5-01` | ربط خطأ طول المنشور 186 بطول UTF-16/Codepoints وحل مصدره | `DIAGNOSTICS_MERGED` | `ROOT_CAUSE_ACCEPTANCE_PENDING` | فحص دقيق للنص قبل الإرسال بدون حذف |
| `ADD-P5-02` | ربط خطأ Duplicate 187 بالمحتوى الأصلي والطابور ومنع تكرار مولّد المحتوى | `DIAGNOSTICS_MERGED` | `ROOT_CAUSE_ACCEPTANCE_PENDING` | تحقيق بالهاش/الروابط وعدم تكرار نشر |

### P6 — 4 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P6-01` | تنقيح الأدلة الجنائية وأرشفتها قبل حد احتفاظ 7 أيام | `MERGED` | `CI_GREEN_REDACTION_VPS_AUDIT_PENDING` | لا تسريب Cookies/Tokens وربط أدلة الحادث |
| `ADD-P6-02` | مراقب الجولة حتى التوقف وCSV وليس أول 16 نجاحًا | `MERGED_PR18` | `AGENT_REPORTED_COMPLETE_LOGS` | تطابق post_result وSQLite وإيصالات الشاتين |
| `ADD-P6-03` | مراجعة Codex المستقلة للـ33 والـ20 الإضافية واعتماد مراحل P1–P6 | `OPEN` | `NOT_RUN` | لا إغلاق قبل استقلال المراجع وموافقة المالك |
| `ADD-P6-04` | مطابقة P1–P6 التاريخية مع مراحل GitHub وجولات M1–M11 وتحديث Issue #12 | `OPEN` | `NOT_RUN` | لا تسقط اعتمادات أو سجلات قديمة؛ تحديث baseline المتقادم |

## Approval gates (still open)

- `FINDING-001`–`FINDING-033`: code may be TESTED_PASS in GitHub's current master, but independent Codex status is **PENDING** for **33/33**.
- P1/P2 final owner signoff is explicitly **PENDING** in GitHub master; P3–P6 do not have recorded independent final acceptance (`NO_SIGNOFF_EVIDENCE`).
- GitHub [Issue #12](https://github.com/yjlvfe/YJAutoPostOnX/issues/12) is **OPEN** and its baseline still describes merged PR #11 as OPEN/DRAFT; update as historical record, do not silently close.
- PRs #11, #13–#19 are merged; retain evidence by SHA; PR #19 is not yet verified on the production VPS after merge.
- Unknown GraphQL codes in historical failed publishes cannot be recovered retroactively by new logging. Audit each ambiguous item independently.

## Linked documents

- [MASTER_TODO.md](MASTER_TODO.md): active repository tracker (its existing lines and statuses are unchanged by this addendum).
- [PROGRESS_HISTORY.md](PROGRESS_HISTORY.md): historical report ledger (only a new entry was added).
- PRs: [#13](https://github.com/yjlvfe/YJAutoPostOnX/pull/13), [#14](https://github.com/yjlvfe/YJAutoPostOnX/pull/14), [#15](https://github.com/yjlvfe/YJAutoPostOnX/pull/15), [#16](https://github.com/yjlvfe/YJAutoPostOnX/pull/16), [#17](https://github.com/yjlvfe/YJAutoPostOnX/pull/17), [#18](https://github.com/yjlvfe/YJAutoPostOnX/pull/18), [#19](https://github.com/yjlvfe/YJAutoPostOnX/pull/19).

---

## Round 10 / M11 evidence-linked progress matrix — 2026-11-03

This matrix is **add-only tracking** for all **20** `ADD-Px-xx` records; it is not a replacement for the 33 original findings or their statuses. It distinguishes code merged, reported evidence, and unfinished acceptance. References: PRs #19–#23, latest verified main `0be50e56e33051b7596ff5e4070a8d46ae3ba16d`, and user-provided Round10 evidence ZIP. The ZIP confirms an audit inventory of 30 quarantined items with 30/30 account IDs and no requeue approvals; it does **not** contain a complete independent live X response log for all 30 outcomes.

| ID | Round 10 state | Established evidence | Still required before closure |
|---|---|---|---|
| `ADD-P1-01` | جزئي | Round10 inventory 30/30 ambiguous with 0 auto-requeues; 13 missing account associations populated; item 53d0 has strong publish-time evidence. | Resolve each item independently; do not mark recovery done while 30 remain quarantined; identify 53d0 disposition safely. |
| `ADD-P1-02` | الكود مدمج / إثبات ناقص | PR #21 enhanced CreateTweet/None diagnostics; CI passed; no definitive new live failure evidence in attached ZIP. | Confirm real next X error code/response and guarantee no second POST. |
| `ADD-P1-03` | الكود مدمج / إثبات ناقص | PR #21 post_result now has run, account, status, dispatch and timing plus GraphQL fields. | Measure real next cycle failed/ambiguous/success and quota with journal reconciliation. |
| `ADD-P1-04` | تكامل جزئي | Dispatch fence and deferred rate-limit handling merged; earlier 21-post M10 run has evidence. | Post-dispatch rate-limit/late-confirmation fault validation without automatic replay. |
| `ADD-P2-01` | دليل تشغيل تاريخي | Owner/brother live panel and start receipts reported in M8–M10. | Current long-run dual-panel/start-source receipt and owner signoff. |
| `ADD-P2-02` | دليل تشغيل تاريخي | M10 telemetry measured publish and SQLite/panel latency. | Correlate next X rejection latency with current logs; distinguish timeline verification overhead. |
| `ADD-P2-03` | دليل تشغيل تاريخي | M10 final CSV receipts in owner and brother chats reported and previously correlated. | Check terminal CSV/stop after PR #23; no CSV omission for actually published posts. |
| `ADD-P3-01` | الكود مدمج / إثبات ناقص | Read-only BEGIN deferred behavior previously merged and tested. | Sustained SQLite latency and writer-contention checks across real cycles. |
| `ADD-P3-02` | جزئي | Round10 inventory 30/30 has accountId, including 13 historically missing; new failureDiagnostic fields merged. | Verify mapping against original raw forensic events; keep attempt provenance and causal diagnostics durable, not just top-level accountId. |
| `ADD-P3-03` | دليل تشغيل تاريخي | M10 verified 21 posts across five accounts, with full run/CSV record. | Further long-run after PR #23 with restarts, resource and no duplicate posts. |
| `ADD-P4-01` | دليل تشغيل تاريخي | PR #15 and M8 reports covered Twikit KeyError urls normalization and live posting. | Confirm no regressions with current pinned Python packages in real X runs. |
| `ADD-P4-02` | الكود مدمج / إثبات ناقص | PR #19/#21 carry GraphQL code/message/status; new source-presence tests and CI green. | Show a genuine new API error end-to-end in sanitized journal and SQLite with exact account/item attribution. |
| `ADD-P4-03` | الكود مدمج / إثبات ناقص | Codes 186/187 exempted from account strikes in PR #19 by classifier. | Verify real rejection code/strike handling, never exempt ban/captcha/auth failures. |
| `ADD-P4-04` | مذكور في تقرير Hermes | Round10 Hermes report says five VPN containers healthy and production service active. | Independent long-run VPN/exit-IP and rotation checks with no host IP leak. |
| `ADD-P5-01` | التشخيص مدمج / العلاج مفتوح | Text length/UTF-16 observations and error code 186 recognition exist in merged code. | Trace overlong output to generator/validation; prevent invalid content before CreateTweet. |
| `ADD-P5-02` | التشخيص مدمج / العلاج مفتوح | Historical posts may duplicate older X posts; original GraphQL code was not recorded, so 187 is not retro-proven. | Prevent duplicate content upstream; avoid equating historical same-text match with current publish success. |
| `ADD-P6-01` | ⚠️ خطر يحتاج إصلاح | PR #23 introduced durable id/epoch for audit events, redaction and migration guards; audit tests call prune/reconcile on Bot/data/state.sqlite. | Move destructive/repair tests to isolated temporary SQLite/JSONL; prove independent durability without touching production; handle dual-write partial failures. |
| `ADD-P6-02` | المراقب مدمج | PR #18 monitor captures through stop and dual CSV receipts; M10 raw journal was correlated to 21 posted items. | Ensure new audit archives carry complete raw journal, exact run scope and evidence retention. |
| `ADD-P6-03` | مفتوح | All 33 original findings and 20 added tasks still Codex PENDING; owner signoffs not granted. | Run independent Codex review using raw evidence; preserve separate owner acceptance by P phase. |
| `ADD-P6-04` | جزئي | PRs #20–#23 preserve P1–P6 and 33+20; original master and Round10 report exist; Issue #12 baseline still stale. | Reconcile Issue #12 and approve PR-linked tracking update without rewriting historic statuses. |

**Independent acceptance gates:** Codex **PENDING for all 33 original findings and all 20 ADD follow-ups**; owner acceptance **PENDING / NO_SIGNOFF_EVIDENCE**. Do not convert a local test pass, static source test, GitHub merge, historical proof, or a chatbot report into production signoff.

**Priority forensic caveats:** `53d0f458` has a same-author tweet ID timestamp within ~6 seconds of its dispatch (strong evidence of publication); keep it **non-retryable** while deciding how to reconcile published status, quota and CSV. The other 29 item outcomes remain independently unresolved. The Round10 `m11_round10_forensic_integrity.test.js` calls `ForensicLogger.prune()` and `reconcile()` against `Bot/data/state.sqlite`; it must be isolated to a **temporary test database** before further production test runs. The migration revert script still appends audit events when invoked with `--apply` even when no items changed; requiring an `--apply` switch alone is not full idempotency. The historical CSV is not an authority for X publication.

**Canonical progress tracker:** the adjacent JSON file contains a `round10` object on **every one of the 20 tasks**, with evidence and remaining acceptance; older implementation/test history is untouched.
