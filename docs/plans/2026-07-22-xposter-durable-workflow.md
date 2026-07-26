# خطة تنفيذ xposter — إصلاح workflow النشر المتين

> **الحالة:** ✅ مكتملة — الدمج الحي تم في 2026-07-26.
> **المستودع:** `/root/projects/xposter`
>
> **ما تم بعد كتابة هذه الخطة:**
> - `xPoster.js` صار يمرّ فعلياً عبر `DurableSession`: `claimNext` → `beginDispatch`
>   (قبل ضغطة الإرسال) → `markPublished`/`markAmbiguous`/`markDeferred`/`markTerminal`.
>   كان الدمج نصف مكتمل والنشر معطّلاً بالكامل قبل ذلك.
> - `queueManager.js` **حُذف**: مسارات JSON القديمة لم يعد لها وجود في الكود الحي،
>   و`workflowMigration` وحده يقرأها مرة واحدة عند أول تشغيل.
> - `publishWorkflow.js` نُقل إلى `test/helpers/dispatchDriver.js` — لم يكن التطبيق
>   يستدعيه أبداً، وسياسة الحدّ اللارجعي التي كان يكرّرها صارت في
>   `dev/automation/dispatchBoundary.js` بنسخة واحدة يشاركها مع `DurableSession`.
> - كل تشغيل يُغلق الآن في `workflow_runs` بدل أن يبقى `active` إلى الأبد.

## العقد غير القابل للتفاوض

1. كل عنصر له UUID ثابت وpayload كامل غير قابل للتعديل، وهو في حالة متينة واحدة فقط.
2. كل profile له UUID ثابت مستقل عن الاسم/rename/delete.
3. كل media تُنسخ إلى content-addressed managed store وتُثبت بالـSHA-256؛ المسار الأصلي وحده ليس durability.
4. `dispatch_started` يثبت قبل `Ctrl+Enter`.
5. بعد حد dispatch: لا automatic retry لأي rejection/Stop/timeout؛ النتيجة ambiguous ما لم يوجد remote proof حاسم.
6. الطابور global، لذلك reconciliation لكل profiles/global intents يسبق cooldown وتشغيل أي profile.
7. العامل لا يحتفظ snapshot قابلًا للنشر؛ كل عنصر يُclaim من المصدر الحي.
8. حذف queued item ينجح بالـID؛ leased/dispatch_started يعيد conflict واضحًا، ولا optimistic success.
9. migration من JSON idempotent عبر staging DB وpromotion ذري، يحتفظ بالأصول، ويستطيع restart بعد crash في كل حد.
10. لا اختبار يلمس `~/.config` الحقيقي أو X أو provider حقيقي.

> **حد الضمان الخارجي:** X لا يقدم idempotency key لهذا المسار القائم على لوحة المفاتيح؛ لذلك لا ندّعي exactly-once مطلقًا. الضمان الممكن هو **at-most-one automatic dispatch لكل محاولة غير محسومة**، ولا retry بعد `dispatch_started` إلا بعد remote proof أو تأكيد يدوي صريح أن المنشور لم يُنشر.

---

# المرحلة A — branch/baseline وRED harness

## A1 — عزل العمل

- إنشاء branch: `repair/xposter-durable-workflow`.
- تسجيل `git status`, HEAD وGraphify report.
- عدم إضافة `.opencode/` أو `graphify-out/` إلى commit الإصلاح إلا في commit توثيق منفصل.

## A2 — توحيد runtime للاختبارات native

**الملفات:** `package.json`, `package-lock.json`, `test/run-all.js`.

1. إضافة `better-sqlite3@12.4.1` و`cross-env`؛ استخدام `electron-builder install-app-deps` بدل dependency زائدة على `@electron/rebuild`.
2. `postinstall` يبني native dependency لـElectron المثبت.
3. تشغيل Node-style tests عبر `ELECTRON_RUN_AS_NODE=1 electron` حتى تستخدم ABI نفسه الذي يستخدمه التطبيق.
4. تجميع قائمة الاختبارات في runner واحد يفشل عند أول exit code غير صفر.
5. إبقاء `test:electron` منفصلًا تحت Xvfb.

**بوابة:** test قديم واحد على الأقل + probe SQLite يعملان تحت Electron-as-Node؛ Electron smoke وAppImage probe يحملان module ويعيدان `quick_check=ok`.

## A3 — اختبارات RED المطلوبة قبل production code

إنشاء:

- `test/workflow-store-state-machine.test.js`
- `test/workflow-json-migration.test.js`
- `test/workflow-dispatch-boundary.test.js`
- `test/workflow-cross-profile-recovery.test.js`
- `test/workflow-live-delete.test.js`
- `test/workflow-fault-injection.test.js`
- `test/workflow-payload-roundtrip.test.js`
- `test/workflow-stop-phases.test.js`

كل test ينشئ HOME/XDG مؤقتًا **قبل require production modules** ثم يحذفه.

### الحالات RED

1. delivered ثم Promise rejection: `dispatches === 1` والحالة `ambiguous`.
2. Stop قبل dispatch: لا dispatch والحالة تعود queued/retryable بأمان.
3. Stop بعد dispatch: dispatch واحد والحالة ambiguous.
4. intent للبروفايل B يمنع A من استهلاك نفس global item.
5. حذف B أثناء نشر A: B لا يصل transport.
6. crash بعد كل commit boundary: restart يضع ID في حالة واحدة.
7. ENOSPC في كل transition: لا source deletion قبل destination authority.
8. full payload `{id,text,media_path,metadata,options}` يبقى مطابقًا في ambiguous/deferred/dead/requeue/published.
9. published tombstone لا يقبل requeue/resurrection.
10. transition مكرر بالـID يعطي نفس النتيجة أو conflict محدد بلا duplicate rows.

**بوابة:** الاختبارات تفشل على HEAD الحالي للأسباب المتوقعة، لا بسبب harness/import/timeout.

---

# المرحلة B — المخزن والمعاملات

## B1 — إنشاء `dev/automation/workflowStore.js`

تهيئة lazy داخل HOME الحالي، بلا `electron.app` حتى يبقى قابلًا للاختبار.

### pragmas

- `journal_mode=WAL`
- `foreign_keys=ON`
- `busy_timeout=5000`
- `synchronous=FULL` لمسار irreversible workflow
- `wal_autocheckpoint` مضبوط ومختبر

### schema مبدئي

كل الجداول `STRICT` حيث يدعم SQLite، وكل JSON عليه `json_valid`/shape checks.

`profiles`:

- `id TEXT PRIMARY KEY` (UUID ثابت).
- `name TEXT NOT NULL UNIQUE`، `status active|deleted`، `legacy_path`، timestamps.

`workflow_runs`:

- UUID، start/heartbeat/finish، وحالة `active|closed|crashed`؛ lease expiry لا يعتمد على الساعة وحدها.

`workflow_items`:

- `id TEXT PRIMARY KEY` مع UUID shape CHECK.
- `queue_seq INTEGER UNIQUE` و`available_at_ms` فقط للحالات المؤهلة.
- `state TEXT NOT NULL CHECK (queued|leased|dispatch_started|published|ambiguous|deferred|dead|discarded)`.
- `payload_json TEXT NOT NULL` immutable + `payload_sha256`؛ generated `text` من JSON.
- `revision`, `lease_token`, `lease_owner_run_id`, `lease_profile_id`, `lease_expires_at_ms`.
- `current_attempt_id`, `last_profile_id`, pre-dispatch failures، reason/error JSON.
- timestamps وresolution fields.
- CHECK مركب يفرض nullability/eligibility الصحيحة لكل state.

`dispatch_attempts`:

- UUID، item/profile/run، attempt number، rendered spintax text، payload hash.
- phase `started|ambiguous|published|confirmed_not_published`.
- external ID/URL، error/resolution timestamps؛ محاولة unresolved واحدة فقط لكل item.

`media_blobs` + `item_media`:

- content-addressed SHA-256، relative path، size، ordinal، original path، status `ready|missing|corrupt`.
- enqueue: temp copy → fsync → hash/size verify → atomic rename → DB transaction.
- crash قبل DB insert يترك orphan آمن للـGC؛ DB لا يشير إلى bytes غير مثبتة.

`api_requests` + `workflow_events` append-only:

- كل mutating IPC يملك requestId/payload hash/result.
- request + transition + event + response في transaction واحدة؛ تكرار requestId يعيد نفس النتيجة، واستخدامه مع payload مختلف يرفض.

`migration_sources`, `migration_rows`, `migration_conflicts`, `schema_migrations` وmetadata للقطع والتحقق.

### indexes

- partial `(available_at_ms, queue_seq)` للحالات queued/deferred.
- partial lease expiry، وglobal recovery `(state, reconciliation_closed_at_ms, updated_at_ms)`.
- profile/state، text/fingerprint، item events.
- unique external ID/URL عندما ليست null.
- unique unresolved dispatch attempt لكل item.

### invariants وحراس DB

- لا physical delete لعناصر workflow أو media refs في الإصدار الأول؛ `discarded` tombstone قبل dispatch فقط.
- triggers تمنع تعديل UUID/payload/hash/created time، وتمنع state transition غير موجودة في الآلة، وتتحقق أن attempt يعود لنفس item.
- كل transition يستخدم `BEGIN IMMEDIATE`/transaction immediate وCAS على id+state+revision+lease token، ويتحقق `changes===1`.
- event row وstate/attempt row في transaction نفسها.
- أي SQLite BUSY/FULL/IOERR في المسار الحرج يوقف دفعة profiles كلها fail-closed.

## B2 — API صريح

- `enqueue(payloads, requestId)`
- `listQueued({after,limit})`
- `claimNext(profileId, runId)` + heartbeat
- `releasePreDispatch(id, leaseToken, reason)`
- `beginDispatch(id, leaseToken, renderedText)`
- `markConfirmed(attemptId, evidence)`
- `markAmbiguous(attemptId, reason, evidence)`
- `markDeferred(id, leaseToken, reason)`
- `markTerminal(id, leaseToken, reason)`
- `discardQueued(id, expectedRevision, requestId)`
- `resolveRecovery(id, action, evidence, requestId)`؛ ambiguous→queued يتطلب `confirmedNotPublished=true`، و“إغلاق المراجعة” يبقي state ambiguous مع timestamp.
- `listRecovery({scope:'global',includeClosed:false})`
- `reconcileStartup()` يعيد leases التابعة لـrun ميت، ويحوّل dispatch_started إلى ambiguous.
- `listPublishedCorpusPage(cursor, limit)`
- `close()` و`checkpoint()`.

**بوابة:** state-machine/fault/payload tests GREEN؛ SQL `quick_check=ok` وFK violations=0 بعد كل fault matrix.

---

# المرحلة C — migration من JSON

## C1 — importer داخل `workflowStore.js` أو `workflowMigration.js`

مصادر legacy:

- shared `queue.json`, `published.json`, `posting-state.json`.
- per-profile `pending-verification.json`, `dead-letters.json`, `deferred-posts.json`.

## C2 — protocol

1. بعد single-instance lock وقبل window/cooldown، خذ migration lock داخل shared dir.
2. اقرأ **bytes** كل JSON مصدر، واحسب path/size/hash؛ شمل كل profile directory حتى المحذوف/غير المسجل.
3. انسخ المصادر إلى backup immutable + manifest مع fsync؛ `.bak` تُسجل ولا تُستخدم بصمت إذا primary تالف.
4. اكتشف media وانسخها إلى managed store مع hash verification؛ media مفقودة تجعل item غير eligible ومرئيًا، لا text-only downgrade.
5. أنشئ `workflow.sqlite.stage.<run-uuid>`، ثم schema وtransaction واحدة تستورد كل source/ordinal وتحفظ migration_sources/rows/conflicts.
6. intent matching يحافظ payload من queue؛ صفر match ينشئ non-eligible `payload_incomplete`، وأكثر من match يُعزل conflict ولا يُدمج عشوائيًا.
7. أولوية التعارض المحافظة: published > ambiguous(intent/pending) > dead > deferred > queued.
8. أعد hash المصادر الحية بعد الاستيراد؛ أي تغير يلغي stage بسبب concurrent writer.
9. تحقق: كل ordinal mapped مرة، integrity/FK، state invariants، media refs، وعدم eligibility لأي published/intent conflict.
10. checkpoint TRUNCATE، أغلق stage، تحقق لا WAL/SHM، fsync DB+directory، ثم atomic rename إلى `workflow.sqlite`.
11. أعد فتح النهائي وتحقق مرة ثانية؛ عندها فقط يصبح SQLite authoritative وتتوقف كل JSON writers. تظل JSON backups read-only ولا dual-write/marker writer.
12. restart إذا final DB يحمل migration complete لا يستورد ثانية. stage المتبقي يُتحقق أو يُعزل؛ لا UUID/row duplicates.
13. rollback قبل أول runtime mutation يمكنه عزل final والعودة إلى JSON؛ بعد أول SQLite mutation **لا fallback تلقائي** لأنه قد يعيد عناصر نُشرت بعد القطع.

## C3 — اختبارات migration

- empty/fresh.
- كل ملف منفردًا.
- duplicates داخل وبين الملفات.
- media payload + managed copy/hash + missing/corrupt/hash-change blockers.
- corrupt primary + valid `.bak`: لا silent fallback؛ conflict/explicit choice.
- crash أثناء backup/media/import، بعد stage commit، بعد promotion وقبل reopen.
- source يتغير بين hash والتحقق النهائي → abort بلا final DB.
- rerun مرتين يعيد UUIDs/rows/events نفسها.
- published+queued same text لا يعيد النشر.
- intent لبروفايل غير موجود في registry يبقى global recovery-visible مع profile UUID محفوظ.
- rename/delete profile لا يغير ownership ولا يحذف workflow/media.

**بوابة:** old JSON fixtures → DB counts/state/payload exact؛ source hashes لم تتغير.

---

# المرحلة D — ربط orchestration الحقيقي

## D1 — `queueManager.js` يصبح adapter رفيعًا

- يمنع كل read-modify-write JSON جديد.
- public APIs تعمل بالـID/payload؛ compatibility مؤقتة فقط حيث يلزم للاختبارات القديمة.
- كل نتيجة mutation تحمل `{ok, conflict, state, id}` بدل boolean صامت.

## D2 — `xPoster.js`

استبدال snapshot loop بـ:

1. `claimNext(profile, runId)` لكل دورة.
2. تحقق Stop قبل browser interaction → release آمن.
3. إعداد composer/media، وحفظ `prepared_json` والنص الفعلي بعد spintax.
4. `beginDispatch()` transaction تنشئ attempt وتثبت `dispatch_started`.
5. بعد نجاح commit فقط، استدعاء transport **مرة واحدة** دون loop.
6. confirmed evidence → `markConfirmed`.
7. أي rejection/Target closed/timeout بعد الخطوة 4 → `markAmbiguous`؛ لا retry.
8. definitive pre-dispatch selector/network → deferred/terminal حسب classifier.
9. consume/transition conflict يوقف run fail-closed ولا يكتب نجاحًا.

## D3 — classifier

قيم حصرية:

- `confirmed`
- `definitive_error_pre_dispatch`
- `rate_limited_pre_dispatch`
- `cancelled_pre_dispatch`
- `ambiguous_post_dispatch`
- `cancelled_post_dispatch`

Toast generic أو composer cleared بلا remote ID = ambiguous، لا confirmed ولا failed auto-retry.

## D4 — startMulti

- `reconcileStartup()` global مرة واحدة قبل أول profile.
- إذا أي unresolved `dispatch_started/ambiguous`: return blocked + recovery list؛ لا profile يبدأ.
- كل profile يستهلك claims global بترتيب sequence.

**بوابة:** كل RED orchestration tests GREEN وtransport counter لا يتجاوز 1 لأي ID.

---

# المرحلة E — IPC/UI

## E1 — `main.js`/`preload.js`

- queue/recovery IPC تعمل بالـID وexpected revision/state.
- central sender/frame/window authorization.
- لا path I/O في call منفصل عن dialog capability.
- start IPC يرفض إذا global reconciliation unresolved.

## E2 — `renderer.js`

- يستخدم backend UUID بدل `q${seq}-${i}`.
- حذف/اختيار/requeue/discard بالـID.
- leased/ambiguous conflict يعرض رسالة ولا يدّعي الحذف.
- recovery panel عالمي قبل profile picker، ويعرض media/metadata/state/time/reason.
- Start disabled ما دام unresolved ambiguity.

## E3 — live delete tests

- queue reload race.
- stale revision.
- selected bulk delete مع بعض العناصر claimed.
- partial success يعرض IDs الناجحة والمتعارضة بدقة.

---

# المرحلة F — lifecycle/security/limits

## F1 — fatal process

- `uncaughtException`/`unhandledRejection`: synchronous bounded log، إيقاف قبول jobs، close/checkpoint، exit non-zero.
- child-process tests تثبت عدم marker بعد fatal.

## F2 — Stop

- AbortController واحد للrun.
- launch/navigation/retry sleep/confirmation waits قابلة للإلغاء.
- context-close errors تُصنف حسب durable phase لا message فقط.

## F3 — bounds

- hard limits للquantity/session count/concurrent calls/total provider calls/prompt bytes/cost estimate.
- رفض مبكر بلا إنشاء sessions/fetch.

## F4 — secrets

- AI key يبقى main-only.
- renderer يرى `hasKey` وmask؛ provider calls تستعيد secret من main storage.

## F5 — paths/CSV

- one-use path capabilities مربوطة sender+operation+extension+expiry.
- CSV writer/parser موحد؛ formula prefix neutralization لكل cell.

---

# المرحلة G — long-run/package

## G1 — dedup/archive

- pagination/streaming لسجل published.
- عدم قراءة/إعادة كتابة corpus كامل بعد كل نشر.
- benchmark 100k/500k: event-loop delay، RSS، bytes written، startup time.

## G2 — retention

- report files: max count/age/bytes per profile، protect newest، filename allowlist.
- event compaction فقط بعد backup/checkpoint، ولا يحذف current/tombstones اللازمة لمنع replay.

## G3 — browser contract

قرار التنفيذ الافتراضي: bundle Playwright Chromium إن كان حجم artifact مقبولًا؛ وإلا preflight متطلب Chrome صريح.

اختبارات:

- Linux VM بلا Chrome.
- Linux system Chrome.
- Windows per-user `%LOCALAPPDATA%` Chrome.
- missing browser قبل claim/dispatch لا يغير queued state.

## G4 — dependencies

- Electron إلى إصدار مدعوم على خطوة مستقلة.
- electron-builder/tooling/tar advisories في commit مستقل.
- لا `audit fix --force`.
- AppImage unpack/load SQLite + Playwright smoke.

---

# بوابات كل commit

1. targeted RED→GREEN.
2. `npm test` كامل.
3. `npm run test:electron`.
4. syntax/static secret/path/SQL scan.
5. `git diff --check`.
6. reviewer مستقل للrequirements ثم code quality.
7. commit `[verified] ...` فقط بعد PASS.

# بوابة إنهاء xposter

- crash matrix لكل transition.
- ENOSPC/permission/fault matrix.
- global cross-profile recovery.
- delivered-then-rejected dispatch count=1.
- UI live delete لا ينشر المحذوف.
- full media payload roundtrip.
- 100k/500k budgets مقبولة.
- Linux AppImage clean-machine smoke.
- audit/runtime gate مقبول.
- لا source warnings جديدة، لا regressions، review مستقل نهائي.
- `git status` معروف، ولا push إلا بطلب صريح.

---

# سجل التنفيذ الفعلي

## مكتمل ومُثبت بتشغيل حقيقي

| الالتزام | المحتوى | التحقق |
|---|---|---|
| `c9e7907` | المتجر المتين على SQLite، مخزن media بالمحتوى، ترحيل JSON، البوابة العامة للاسترداد | 34/34 + مجموعة Electron |
| `fda4403` | `renewLease`، `reclaimExpiredLeases`، حجر الصفوف الفاسدة في `reconcileStartup` | 35/35 |
| `a82b978` | إغلاق blocker معاد فتحه عند `beginDispatch`، منع بقاء العنصر في `leased`، سقف الفشل، إثبات على مستوى المتجر، GC للوسائط، `pruneIdempotency`، كشف split-brain | 37/37 |

### نتائج المراجعات المستقلة المدمجة

1. **blocker أُعيد فتحه:** البوابة كانت في `leaseNext` فقط؛ عامل حجز *قبل* ظهور الغموض كان يعبر الحدّ. أُصلح بإعادة الفحص داخل معاملة `beginDispatch` نفسها.
2. **العنصر كان يعلق في `leased`** عند أي خطأ حارس — غير مرئي في الطابور ولا في شاشة الاسترداد. الآن كل خطأ يُحسم إلى حالة متينة.
3. **`preDispatchFailureCount`** كان يُزاد ولا يُقرأ ⇒ عنصر مسموم يدور للأبد. الآن سقف قابل للضبط ثم `dead`.
4. **`markPublished`** كان يقبل إثباتًا فارغًا (مسار الاسترداد اليدوي يستدعيه مباشرة) ⇒ `PROOF_REQUIRED`.
5. **النمو:** `api_requests` قيس بـ53.5% من حجم القاعدة (~102MB عند 10k منشور) ⇒ `pruneIdempotency` مع trigger احتجاز؛ وأيتام media لم يكن لها أي كاشف أو منظّف ⇒ `sweepOrphanMedia` + تقرير في `integrityCheck`.

### مفتاح الهروب `allowUnresolvedRecovery`

افتراضيًا `false`، ويُرفض إن لم يكن boolean. المستدعي الوحيد هو `workflowMigration` الذي يعمل على قاعدة staging منفصلة ولا يستورد أي ناقل. `publishWorkflow` لا يمرره ولا يقبله من المتصل.

## المتبقي

- **D/E — الدمج الحي (التالي):** استبدال مسارات `queueManager`/`xPoster`/IPC/UI بالآلة الجديدة. حتى ذلك الحين العيوب المُصلحة كامنة لأن الطبقة غير مربوطة.
- **F/G:** retention للتقارير، عقد المتصفح، ترقية Electron/التبعيات، ميزانيات 100k/500k.
- **اختبار انهيار حقيقي:** المراجعة أثبتت أن السلوك تحت `SIGKILL` سليم فعلًا (WAL غير مُنقّط ⇒ تعافٍ صحيح)، لكن اختبار المجموعة يستخدم `close()` نظيفًا ⇒ يجب استبداله بعملية فرعية تُقتل فعليًا حتى لا يمر انحدار مستقبلي بصمت.

بعدها فقط يبدأ إعداد branch وخطة تنفيذ SondooqPro.
