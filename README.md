# YJAutoPostOnX 🚀

**Automated posting tool for X.com (Twitter)** — CSV-based scheduling with Playwright browser automation.

Post tweets automatically from a CSV file with built-in anti-detection, media upload, and multi-profile support.

---

## ✨ Features

- 📂 **CSV Import** — Import posts from CSV files (text + optional media paths)
- 🖼️ **Media Upload** — Auto-detect media column in CSV and upload images/videos
- 👤 **Multi-Profile** — Manage multiple X.com accounts with separate browser profiles
- ⏱️ **Scheduled Posting** — Set speed (minutes between posts) and max post count
- 🔄 **Smart Queue** — Persistent queue with dead letter handling and retry logic
- 🛡️ **Anti-Detection** — Human-like behavior: random delays, mouse movements, scrolling
- 📊 **Live Logs** — Real-time status updates, countdown timer, success/fail counters
- 📝 **CSV Output** — Auto-generated output logs with timestamps and post URLs
- 🔄 **Auto Retry** — 3 retry attempts with network recovery on failure
- 🧩 **Spintax Support** — `{option1|option2}` syntax for post variation in CSV

---

## 📋 Requirements

- **OS:** Linux (Ubuntu 22.04+), macOS, Windows
- **Node.js:** v18+
- **npm:** v9+

---

## 🚀 Quick Start

### 1. Install

```bash
git clone https://github.com/yjlvfe/YJAutoPostOnX.git
cd YJAutoPostOnX
npm install
```

### 2. Prepare Your CSV

Create a CSV file with your posts:

```csv
Text,Media
"Check out this amazing project!",/path/to/image1.jpg
"This is my second post! 🚀",
"{Option A|Option B|Option C} for spintax variety!",
```

- **Column 1:** Post text (max 270 characters)
- **Column 2 (optional):** Path to media file (image/video)

### 3. Run

```bash
npm start
```

---

## 🎯 How to Use

### First-Time Setup

1. **Launch the app:** `npm start`
2. **Log in to X:** Click "Login / Account" to open a browser window and log in to your X.com account
3. **Select output folder:** Choose where to save logs
4. **Import CSV:** Click "Import CSV" and select your post file
5. **Set speed:** Configure minutes between each post
6. **Click "Start"** to begin posting

### Managing Multiple Accounts

1. Click "➕" to create a new profile
2. Switch profiles using the dropdown
3. Each profile has its own browser session and login state

### Customizing Templates (Spintax)

Use spintax `{option1|option2|option3}` in your CSV posts:

```
{I love|I enjoy|I'm passionate about} {coding|building|creating} {amazing|awesome|great} things!
```

The system randomly picks one option from each `{...}` group every time it posts.

---

## 🏗️ Project Structure

```
YJAutoPostOnX/
├── src/
│   ├── main.js                    # Electron main process
│   ├── preload.js                 # Context bridge (IPC API)
│   ├── ui/
│   │   ├── index.html             # UI layout
│   │   ├── renderer.js            # UI logic
│   │   └── styles.css             # Styles
│   └── automation/
│       ├── xPoster.js             # Core posting engine
│       ├── browserManager.js      # Browser profile management
│       ├── queueManager.js        # Post queue persistence
│       └── reportEngine.js        # Reporting & logging
├── package.json
├── LICENSE
└── README.md
```

---

## ⚙️ Configuration

Settings are saved to `~/.config/x-poster-bot-profile/config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `speed` | Minutes between posts | 5 |
| `maxPosts` | Maximum posts per session | 9999 |
| `outputFolder` | Directory for log files | (user-selected) |

---

## 🛠️ Building from Source

```bash
# Build AppImage for Linux
npm run build:linux

# Output: dist/YJAutoPostOnX-*.AppImage
```

---

## 📝 CSV Format Details

```
Text,Media
"Your post text here (max 270 chars)",/absolute/path/to/image.jpg
```

- **Encoding:** UTF-8
- **Headers:** First row is ignored (use `Text,Media` or any header)
- **Text column:** Column A — the tweet content
- **Media column:** Auto-detected as any column with a file path ending in common image/video extensions (jpg, png, gif, mp4, etc.)
- **Character limit:** Posts over 270 characters are automatically skipped

---

## 🔒 Security

- Browser profiles are isolated per X.com account
- No data is sent to external servers
- All automation runs locally on your machine

---

## 📄 License

MIT

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first.
