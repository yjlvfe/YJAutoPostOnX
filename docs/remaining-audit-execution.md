# YJAutoPostOnX — تنفيذ نتائج التدقيق المتبقية

الحالة: قيد التنفيذ على الفرع `fix/remaining-audit-20260726` فقط. لا دمج إلى `main` قبل نجاح الاختبارات والحزمة المبنية.

## ترتيب التنفيذ

1. **XP-006 — الهوية والحقيقة في الواجهة**
   - كل queue/recovery mutation تستخدم `id + expectedRevision + requestId`.
   - النص للعرض فقط ولا يُستخدم لتحديد الصف.
   - مسارات منفصلة: confirm published مع proof، confirm not published + requeue، requeue dead، discard dead.
   - لا generic discard لحالة ambiguous.
   - عرض blocked/conflict/deleted counts الحقيقية وإعادة تحميل queue + recovery بعد كل mutation.

2. **Fail-closed readiness**
   - أخطاء قراءة queue/recovery/store لا تتحول إلى قوائم فارغة.
   - حالة typed: ready / blocked-recovery / degraded / error / stopping.
   - workflow health ظاهر للمستخدم ويمنع start عند integrity error.

3. **XP-010 — backup وretention**
   - verified SQLite backup متوافق مع WAL مع rotation واختبار restore في staging.
   - retention آمن للأحداث والمحاولات والتقارير والوسائط مع استثناء كل unresolved evidence.
   - dry-run وقياس reclaimed bytes وسجل تدقيق.

4. **XP-012 / XP-013**
   - Browser sandbox بحسب executable الفعلي.
   - dependency upgrades تدريجية مع ABI/package tests.
   - تنظيم test scopes وpackage smoke وتقليل preload/IPC surface.

## بوابات كل مرحلة

- اختبار RED يفشل للسبب الصحيح.
- GREEN بعد إصلاح السبب الجذري.
- `npm test`.
- `npm run test:electron` عند لمس IPC/renderer.
- `git diff --check`.
- لا X حي، لا مزود AI مدفوع، وكل HOME/XDG مؤقتة.

## تعريف الإغلاق

لا يصبح PR جاهزًا للمراجعة حتى تنجح AppImage package smoke، وتُوثق القيود المتبقية دون ادعاء زائد.
