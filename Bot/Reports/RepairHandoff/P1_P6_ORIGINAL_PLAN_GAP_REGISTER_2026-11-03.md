# YJAutoPostOnX — ADD-ONLY gap register for original P1–P6 plan

**Date:** 2026-11-03 | **Source:** original user-uploaded TODO v1.2 (2026-11-01) + GitHub source and reports through PR #19.

## Invariants
- Historical original: **33 findings** across P1(5), P2(4), P3(10), P4(9), P5(3), P6(2). **DO NOT rewrite, reclassify, or convert original records**.
- This file contains **20 new follow-ups**, separately named `ADD-Px-xx`; they do not become new original FINDING IDs.
- GitHub's M1–M11 labels are test/production rounds, **not replacements** for P1–P6. GitHub MASTER_TODO has a different internal phase taxonomy; do not overwrite the source's P1–P6 taxonomy.
- Implementation, test evidence, Codex signoff, and owner-production acceptance are separate fields. **All 33 original Codex approvals remain PENDING**, as do approval gates for these new tasks.
- The figure **~30 ambiguous** is from the last owner screenshot, not a fresh live SQLite query. Never auto-requeue post-dispatch ambiguous items without authoritative evidence.
- The main branch verified here: `8b49f3590fe2c332547b64c57af8603599608b54` (PR #19 merged; GitHub CI success, VPS post-PR19 verification not yet delivered).

## Additional work by ORIGINAL P phase

### P1 — 4 additions

| ID | Additional work | Implementation | Test evidence | Closure criteria |
|---|---|---|---|---|
| `ADD-P1-01` | جرد جميع المنشورات الغامضة (~30 في آخر لوحة) وتصنيف مصير كل itemId دون إعادة جماعية | `OPEN` | `NOT_RUN` | دليل حالة كل عنصر + استعادة ذرية فقط عند إثبات عدم النشر |
| `ADD-P1-02` | تمييز رفض GraphQL المؤكد من نتيجة ما بعد dispatch غير المحسومة | `PARTIAL_MERGED` | `VPS_E2E_PENDING` | إثبات سياسة إعادة/حجر آمنة دون POST مكرر |
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
| `ADD-P4-02` | نقل أكواد ورسائل GraphQL/HTTP وكشف خطأ التحقق من Python إلى Node وSQLite | `MERGED_PR19` | `CI_GREEN_VPS_E2E_PENDING` | أسباب X الأصلية لكل فشل دون أسرار في اللوج |
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
