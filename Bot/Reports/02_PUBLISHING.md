# 02_PUBLISHING — محرك النشر على X، جسر بايثون، التحقق ومخاطر التكرار

---

## 🎯 مقدمة ونطاق المحرك
يمثل محرك النشر النواة الوظيفية الأكثر حساسية في مشروع **YJAutoPostOnX**. نظراً لعدم استخدام واجهات API الرسمية (OAuth v2 API)، يعتمد المحرك على محاكاة طلبات عميل الويب لمنصة X عبر بروتوكول **GraphQL (CreateTweet Endpoint)** باستخدام مكتبة Twikit ونواة نقل هجينة تجمع بين `curl_cffi` (لتجاوز حماية Cloudflare وبصمات TLS/JA3) ومكتبة `httpx` للمهام المساندة.

أثبتت التحقيقات الجنائية والاختبارات المعزولة وجود **طبقتين مستقلتين تماماً لإعادة الإرسال غير الآمن** تؤديان حتماً إلى تكرار نشر التغريدات نفسها على حسابات المستخدمين عند حدوث أدنى اضطراب شبكي أو بطء في خوادم X.

---

## ⚙️ معمارية طبقة النقل (Python OnlySocksTransport)

توجد هذه الفئة في `Bot/python/direct_x_bridge.py:160-205`:

```python
# اقتباس دقيق من الكود الفعلي direct_x_bridge.py:174-196
            try:
                url = str(request.url)
                method = request.method
                headers = dict(request.headers)
                headers.pop('host', None)
                headers.pop('content-length', None)
                content = await request.aread()
                resp = await self._curl_session.request(
                    method=method,
                    url=url,
                    headers=headers,
                    data=content if content else None,
                    allow_redirects=False
                )
                clean_headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in ('content-encoding', 'transfer-encoding')]
                return httpx.Response(
                    status_code=resp.status_code,
                    headers=clean_headers,
                    content=resp.content,
                    request=request
                )
            except Exception:
                return await self.transport.handle_async_request(request)
```

### الخلل الجذري رقم 1: السقوط البديل غير المشروط (Unchecked Fallback)
1. **طبيعة طلبات النشر (Non-Idempotent POST):** طلب إنشاء تغريدة هو طلب HTTP `POST`. إذا أرسلت مكتبة `curl_cffi` بايتات الطلب كاملة إلى خادم X، وقام الخادم بإنشاء التغريدة وتخزينها، ثم تعطل المقبس الشبكي (Socket Drop) أو تأخر رد الخادم فتجاوزت المهلة المحددة (Timeout)، تطلق `_curl_session.request` استثناء `Exception`.
2. **الكارثة في `except Exception`:** بدلاً من التحقق مما إذا كان الطلب قد عبر حدود الإرسال (Send Boundary)، يقوم الكود فوراً وبشكل أعمى باستدعاء `self.transport.handle_async_request(request)`، وهو نقل `httpx` القياسي.
3. **النتيجة الحتمية:** يستقبل خادم X نفس طلب الـ POST للمرة الثانية وينشر تغريدة ثانية مطابقة تماماً، مما يسبب تكراراً مباشراً على الحساب.

---

## 🔍 محرك التحقق من التايملاين (`verify_timeline`)

عند فشل طلب النشر المباشر أو حدوث استثناء غير مؤكد، يستدعي الجسر دالة `verify_timeline` في `direct_x_bridge.py:377-503` للاستعلام عن آخر تغريدات الحساب والتأكد مما إذا كانت التغريدة قد نُشرت رغم انقطاع الاتصال.

تحتوي هذه الدالة على 4 عيوب تصميمية قاتلة تم إثباتها بالأدلة والاختبارات:

### 1. المطابقة الجزئية لأول 40 حرفاً (Prefix False Positive)
في السطور `455-457`:
```python
elif len(sent_norm) >= 20 and len(tweet_norm) >= 20 and (
    sent_norm.startswith(tweet_norm[:40]) or tweet_norm.startswith(sent_norm[:40])
):
    matched = True
```
- **المشكلة:** إذا كانت هناك تغريدتان تشتركان في نفس البداية (مثل مقدمة شائعة: *"بسم الله الرحمن الرحيم - نتابع معكم حركة بيتكوين اليوم..."*) ولكن باقي المحتوى مختلف تماماً، تعتبر الدالة التغريدة الجديدة منشورة بنجاح فوراً!
- **الأثر:** يتم تسجيل المنشور كمنشور بنجاح (`published`)، وتُستهلك الكوتا، بينما التغريدة الجديدة الفعلية لم تُنشر على الإطلاق.

### 2. سباق تزامن التايملاين مع الانتشار البطيء (Eventual Consistency Race)
في السطور `486-487`:
```python
if attempt == 0:
    await asyncio.sleep(2)
```
- **المشكلة:** شبكة X تعتمد معمارية قواعد بيانات موزعة ذات انتشار غير فوري (Eventual Consistency). يستغرق ظهور التغريدة في تايملاين المستخدم من 5 إلى 60 ثانية في أوقات الذروة.
- فحص الدالة يكتفي بمحاولتين فقط مع تأخير مدته ثانيتان بينهما.
- **النتيجة:** تفشل الدالة في رؤية التغريدة المنشورة حديثاً، فتصدر قراراً قاطعاً بالغياب: `verifiedNotPosted = True`.

### 3. إهمال التصفح والصفحات المتعددة (Cursor Truncation)
- دالة `verify_timeline` تستعلم عن الصفحة الأولى فقط عبر GraphQL مع `cursor=None`.
- إذا كان الحساب نشطاً ولديه ردود أو تغريدات حديثة، وتأخر ظهور التغريدة إلى الصفحة الثانية، لا يقوم الكود بطلب الصفحة التالية نهائياً، ويعلن أن التغريدة لم تُنشر.

### 4. التسامح مع غياب التاريخ والوقت (Missing Date Match)
- في دالة `is_recent_tweet`، إذا كانت بيانات التغريدة المستلمة من GraphQL تفتقر إلى حقل التاريخ أو تعذر تحليله، تفترض الدالة افتراضاً كارثياً أن التغريدة حديثة (`True`)، مما يجعل أي تغريدة قديمة تشترك في البداية تبدو وكأنها التغريدة الحالية المنشورة للتو!

---

## 🔁 طبقة إعادة الإرسال الثانية في المنظم (`runner.js`)

توجد في `Bot/src/runner.js:579-648`:

```javascript
// runner.js:579
const newState = result.published && result.url ? 'published' : 
  (result.published || result.ambiguous || (callbackAdapter && dispatchEntered && !result.verifiedNotPosted)) ? 'ambiguous' : 
  ['text_too_long', 'tweet_too_long'].includes(result.reason) ? 'cancelled' : 'pending';

// runner.js:643-647
} else if (result.retryable === true && (result.verifiedNotPosted === true || (!dispatchEntered && result.reason === 'identity_read_unavailable')) && !result.accountFailure) {
  retry = true; safeTransient = true;
  if (result.verifiedNotPosted) {
    await notify(`ℹ️ تحقق الـ Timeline: المنشور (${item.id.slice(0,8)}…) لم يُنشر فعلياً على X؛ سيُعاد إرساله بأمان دون تكرار.`);
  }
```

### الخلل الجذري رقم 2: الثقة العمياء في `verifiedNotPosted`
- عندما يعود جسر بايثون بنتيجة `verifiedNotPosted: true` (بسبب سباق الـ 2 ثانية أعلاه)، يعتقد `runner.js` بناءً على هذا الإشعار الزائف أن التغريدة لم تصل مطلقاً إلى منصة X.
- يقوم المنظم فوراً بإعادة تعيين حالة المنشور إلى `pending`، ويحذف كائن المحاولة `attempt`، ويعيد المنشور إلى رأس الطابور لإعادة إرساله فوراً.
- **التفاعل بين الطبقتين:**
  1. طلب POST الأول ينشر التغريدة في X، لكن الرد ينقطع.
  2. فحص التايملاين يفشل بعد ثانيتين ويعيد `verifiedNotPosted`.
  3. المنظم يعيد إرسال التغريدة فوراً.
  4. النتيجة: تغريدتان متطابقتان تظهران على حساب X بفاصل زمني بضع ثوانٍ!

---

## 💥 استثناء `KeyError: 'urls'` وتوافقية Twikit

في الإصدارات السابقة، أدى استعلام GraphQL لجلب بيانات الحساب في `twikit` إلى انهيار العملية بسبب غياب حقل `urls` داخل كيان `legacy.entities`:

```
KeyError: 'urls'
  at twikit/user.py in __init__
  entities['url']['urls']
```

### الحل المطبق في `direct_x_compat.py`:
تم إنشاء فئة توافقية مخصصة `_compat_user_data`:
```python
def _compat_user_data(data):
    if not isinstance(data, dict): return data
    result = dict(data)
    legacy = result.get('legacy')
    if isinstance(legacy, dict):
        legacy = dict(legacy)
        entities = legacy.get('entities', {})
        if isinstance(entities, dict):
            entities = dict(entities)
            description = entities.get('description', {})
            if isinstance(description, dict):
                description = dict(description)
                description.setdefault('urls', [])
                entities['description'] = description
            entities.setdefault('url', {'urls': []})
            legacy['entities'] = entities
        result['legacy'] = legacy
    return result
```
*هذا الحل الهندسي ممتاز لأنه يعزل المشكلة بدون Monkey Patching عام، لكنه يحتاج إلى تعميم على كافة الكيانات الواردة من GraphQL لتفادي استثناءات مشابهة مستقبلاً.*

---

## 🧪 نتائج الاختبارات المعزولة (Evidence Matrix)

أثبتت جولة الاختبارات الـ 38 المعزولة في بيئة الشبكة المغلقة (Loopback Isolation) الحقائق التالية بدقة قاطعة:

| رمز الاختبار | السيناريو المختبر | السلوك المرصود في الكود الفعلي | النتيجة والبرهان |
|---|---|---|---|
| **`A_SUCCESS`** | إرسال طبيعي ناجح | استلام POST واحد، تسجيل رقم التغريدة | **PASS:** استلام واحد، خروج نظيف 0 |
| **`A_CURL_FAILOVER`** | فشل curl قبل عبور شبكة الإرسال | استدعاء httpx كبديل آمن قبل خروج البايتات | **PASS:** استلام واحد فقط على الخادم |
| **`A_ACCEPT_DROP`** | الخادم استلم الطلب ثم قطع الاتصال | محرك بايثون أعاد إرسال الطلب تلقائياً عبر httpx | **FAIL (المشكلة مثبتة):** الخادم استلم طلبين POST متطابقين! |
| **`A_DELAY`** | الخادم تأخر في الرد عن مهلة curl | محرك بايثون أعاد إرسال الطلب تلقياً عبر httpx | **FAIL (المشكلة مثبتة):** الخادم استلم طلبين POST متطابقين! |
| **`B_LOST_EMPTY`** | تايملاين فارغ بعد استلام الطلب | إرجاع `verifiedNotPosted`، وإعادة Runner للإرسال | **FAIL (المشكلة مثبتة):** استلام 8 طلبات POST لنفس العنصر في 4 دورات! |
| **`B_RUNNER_REPLAY_ONLY`** | تعطيل إعادة بايثون وحصر الإعادة في Runner | المنظم يعيد النشر بمفرده بسبب كذبة التايملاين | **FAIL (المشكلة مثبتة):** 4 طلبات POST من المنظم لنفس العنصر! |
| **`E_PREFIX_DATED`** | تغريدتان تبدآن بنفس الـ 40 حرفاً | قبول التغريدة وتأكيد نشرها زوراً | **FAIL (المشكلة مثبتة):** تطابق زائف واستهلاك كوتا بدون نشر حقيقي |
| **`E_NODATE`** | تغريدة قديمة بدون حقل تاريخ | قبول التغريدة على أنها حديثة وتأكيد النجاح | **FAIL (المشكلة مثبتة):** تطابق زائف وتأكيد نجاح غير مبرر |
| **`E_PAGE2_CORRECTED`** | التغريدة ظهرت في الصفحة 2 من التايملاين | عدم قراءة الصفحة 2، وإعلان عدم النشر وإعادة الإرسال | **FAIL (المشكلة مثبتة):** إعادة إرسال منشور تم نشره بالفعل |
| **`E_LATE_VISIBLE`** | تأخر ظهور التغريدة لأكثر من ثانيتين | الدالة لم تنتظر كفاية، وأعلنت عدم النشر | **FAIL (المشكلة مثبتة):** إعادة إرسال منشور تم نشره بالفعل |

---

## 🔒 متطلبات الأمان الإلزامية لمحرك النشر

1. **إلغاء السقوط البديل (No Fallback on Ambiguous POST):** منع أي إعادة إرسال لطلبات POST في طبقة النقل ما لم يكن مؤكداً رياضياً وقطعياً أن البايتات لم تخرج من كرت الشبكة.
2. **إلغاء حالة `verifiedNotPosted` لطلبات النشر الحديثة:** أي فشل بعد مصافحة الإرسال يجب أن يُعامل كحالة غامضة دائمية (`ambiguous`) لا يجوز للنظام الآلي إعادة إرسالها دون تدخل المشرف.
3. **المطابقة التامة للنص (Exact Text & Hash Matching):** إلغاء مطابقة أول 40 حرفاً، والاعتماد على SHA-256 للنص بعد معالجة المسافات والتطويل فقط.
4. **دعم التصفح الكامل والمهل المرنة:** قراءة الـ Cursors المتعددة في التايملاين ومراعاة تباعد زمني لا يقل عن 15-30 ثانية قبل إصدار أي حكم تشخيصي.
