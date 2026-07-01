# YJAutoPostOnX 🚀

**أداة نشر تلقائي على X.com (Twitter)** — تطبيق Electron بسحب AI لإنشاء محتوى عربي كريبتو، جدولة ذكية، ودعم بروفايلات متعددة.

---

## ✨ المميزات

- 🧠 **محرك AI** — إنشاء تغريدات عربي كريبتو بأي مزود OpenAI-compatible
- 👤 **بروفايلات متعددة** — إدارة حسابات X متعددة بجلسات متصفح منفصلة
- 🔄 **جدولة ذكية** — نشر تلقائي مع تحكم بالسرعة وحدود الطلبات
- 🛡️ **مكافحة الكشف** — سلوك بشري: تأخيرات عشوائية، حركة فأرة، تمرير
- 🔒 **تدقيق أمني** — فحص تلقائي للإعدادات و API keys
- 📊 **تقارير حية** — حالة فورية، عد تنازلي، عدادات نجاح/فشل
- 🔄 **إعادة محاولة** — 3 محاولات مع استعادة الشبكة
- 📝 **إدارة الجلسات** — جلسات AI مسطحة stateless بدون نمو thread متزايد
- 🎨 **مولد محتوى** — محتوى عربي تعبوي مع روابط إحالة MEXC
- ⏱️ **Rate Limit** — توقف تلقائي عند ضرب الحد + انتقال للبروفايل التالي + كولداون
- 🧩 **Spintax** — `{خيار1|خيار2}` لتنويع التغريدات

---

## 📋 المتطلبات

- **OS:** Linux (Ubuntu 22.04+), macOS, Windows
- **Node.js:** v18+
- **npm:** v9+

---

## 🚀 التشغيل

```bash
git clone https://github.com/yjlvfe/YJAutoPostOnX.git
cd YJAutoPostOnX
npm install
npm start
```

### البناء

```bash
# AppImage للينكس
npm run build:linux

# النتيجة: dist/YJAutoPostOnX-*.AppImage
```

### الاختبار

```bash
npm test          # 87 اختبار
npm run audit     # تدقيق أمني
```

---

## 🏗️ هيكل المشروع

```
YJAutoPostOnX/
├── src/
│   ├── main.js                    # Electron main process + IPC
│   ├── preload.js                 # Context bridge
│   ├── automation/
│   │   ├── xPoster.js             # محرك النشر الأساسي (Playwright)
│   │   ├── sessionManager.js      # إدارة جلسات AI
│   │   ├── contentEngine.js       # محرك توليد المحتوى AI
│   │   ├── browserManager.js      # إدارة بروفايلات المتصفح
│   │   ├── queueManager.js        # طابور النشر المستمر
│   │   ├── rateLimitStore.js      # حدود الطلبات + كولداون
│   │   ├── referralService.js     # خدمة روابط الإحالة
│   │   └── reportEngine.js        # التقارير و السجلات
│   ├── security/
│   │   ├── auditor.js             # تدقيق أمني
│   │   ├── validator.js           # فحص المدخلات
│   │   └── migrator.js            # ترحيل الإعدادات
│   └── ui/
│       ├── index.html             # واجهة المستخدم
│       ├── renderer.js            # منطق الواجهة
│       └── styles.css             # الأنماط
├── test/                          # اختبارات
├── package.json
├── LICENSE
└── README.md
```

---

## ⚙️ الإعدادات

يتم حفظ الإعدادات تلقائياً في `~/.config/x-poster-bot-profile/config.json`:

| الإعداد | الوصف | الافتراضي |
|---------|-------|-----------|
| `speed` | دقائق بين كل تغريدة | 5 |
| `maxPosts` | أقصى عدد بالنسبة للجلسة | 9999 |
| `outputFolder` | مجلد السجلات | (اختيار المستخدم) |
| `aiBaseUrl` | رابط API الذكاء الاصطناعي | — |
| `aiApiKey` | مفتاح API | — |
| `aiModel` | نموذج AI | — |

---

## 📄 الرخصة

MIT License — انظر ملف [LICENSE](LICENSE)

---

## 🤝 المؤلف

**YJLVFE** — [github.com/yjlvfe](https://github.com/yjlvfe)
