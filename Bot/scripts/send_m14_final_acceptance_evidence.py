import os
import sys
import json
import pathlib
import hashlib
import urllib.request
import zipfile
from datetime import datetime, timezone

def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env

def send_telegram_document(token, chat_id, file_path, caption):
    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    with open(file_path, 'rb') as f:
        file_bytes = f.read()
    filename = os.path.basename(file_path)

    body = (
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="chat_id"\r\n\r\n'
        f'{chat_id}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="caption"\r\n\r\n'
        f'{caption}\r\n'
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\n'
        f'Content-Type: application/zip\r\n\r\n'
    ).encode('utf-8') + file_bytes + f'\r\n--{boundary}--\r\n'.encode('utf-8')

    url = f'https://api.telegram.org/bot{token}/sendDocument'
    req = urllib.request.Request(url, data=body)
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode('utf-8'))

def build_zip(source_dir, zip_path):
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            for file in files:
                full_path = os.path.join(root, file)
                arcname = os.path.relpath(full_path, start='/tmp')
                zipf.write(full_path, arcname)

def main():
    source_dir = '/tmp/m14_final_acceptance_evidence'
    zip_path = '/tmp/Round14_M14_PR27_Final_VPS_Acceptance_Evidence.zip'

    # 1. Build the sanitized evidence archive
    build_zip(source_dir, zip_path)
    file_bytes = pathlib.Path(zip_path).read_bytes()
    zip_sha256 = hashlib.sha256(file_bytes).hexdigest()
    zip_size = len(file_bytes)
    print(f"Archive built: {zip_path}")
    print(f"Archive size: {zip_size} bytes")
    print(f"Archive SHA-256: {zip_sha256}")

    # 2. Load authorized bot token
    env = load_env('/root/Projects/YJAutoPostOnX/Bot/.env.local')
    token = env.get('TELEGRAM_BOT_TOKEN')
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN not found in .env.local", file=sys.stderr)
        sys.exit(1)

    caption = (
        "🛡️ *YJAutoPostOnX — M14 / PR #27 Final VPS Acceptance Evidence Package*\n"
        "• PR: #27 (Branch: fix/m14-human-captcha-real-session-guard-and-recovery)\n"
        "• Head: fcdaad3 | Candidate Head: d60cdf2\n"
        "• Status: ALL Final Acceptance Gates PASSED (Pre-Merge Accepted)\n"
        "• Mutex: SQLite transactional log mutex with PID starttime fencing\n"
        "• Alerting: Per-incident scoping, verified Bot API receipts & dual-admin retry\n"
        "• Tests: 207/207 Python PASS (0.76s) | 453/453 Node.js PASS (61.4s) | 100%\n"
        "• GitHub CI: 5/5 Checks PASS (Audit 41707718029 / Release 41707722699)\n"
        "• Safety: 0 Live POST | Cycle Stopped | 3 Accounts Disabled | 30 Items Quarantined"
    )

    targets = ['528864559', '5535435580']
    receipts = {}
    raw_responses = {}

    # 3. Dispatch to both authorized chats
    for chat_id in targets:
        print(f"\nDispatching evidence ZIP to Telegram chat {chat_id}...")
        res = send_telegram_document(token, chat_id, zip_path, caption)
        raw_responses[chat_id] = res
        if res.get('ok'):
            msg_id = res.get('result', {}).get('message_id')
            receipts[chat_id] = msg_id
            print(f"  ✓ Delivered to {chat_id}: message_id={msg_id}")
        else:
            print(f"  ✗ Delivery failed to {chat_id}: {res}", file=sys.stderr)
            sys.exit(1)

    # 4. Generate SEPARATE delivery manifest without modifying the delivered archive
    manifest_data = {
        "manifest_type": "YJAutoPostOnX_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "delivered_archive": {
            "filename": os.path.basename(zip_path),
            "size_bytes": zip_size,
            "sha256": zip_sha256
        },
        "git_provenance": {
            "pr_number": 27,
            "pr_url": "https://github.com/yjlvfe/YJAutoPostOnX/pull/27",
            "branch": "fix/m14-human-captcha-real-session-guard-and-recovery",
            "candidate_head_sha": "d60cdf212d04f93a5e91bd639cf5642a3540c8b1",
            "acceptance_head_sha": "fcdaad38cf803c95855b0d91fb3c346d3d5e2efe"
        },
        "github_ci_runs": {
            "audit_completion": {
                "run_id": 41707718029,
                "url": "https://github.com/yjlvfe/YJAutoPostOnX/actions/runs/41707718029",
                "status": "success",
                "jobs": ["baseline-tests", "workflow-tests", "electron-tests", "package-appimage"]
            },
            "release_verify": {
                "run_id": 41707722699,
                "url": "https://github.com/yjlvfe/YJAutoPostOnX/actions/runs/41707722699",
                "status": "success",
                "jobs": ["npm ci / test / test:electron / audit / build / package smoke"]
            }
        },
        "telegram_delivery_receipts": [
            {
                "recipient": "owner",
                "chat_id": "528864559",
                "message_id": receipts.get("528864559"),
                "status": "delivered",
                "telegram_api_ok": True
            },
            {
                "recipient": "brother",
                "chat_id": "5535435580",
                "message_id": receipts.get("5535435580"),
                "status": "delivered",
                "telegram_api_ok": True
            }
        ],
        "raw_telegram_responses": raw_responses
    }

    manifest_json_path = '/tmp/Round14_M14_PR27_Final_VPS_Acceptance_Delivery_Manifest.json'
    with open(manifest_json_path, 'w', encoding='utf-8') as f:
        json.dump(manifest_data, f, indent=2)

    manifest_bytes = pathlib.Path(manifest_json_path).read_bytes()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()

    print(f"\n==========================================")
    print(f"DELIVERY MANIFEST CREATED (SEPARATE FROM ZIP)")
    print(f"Manifest path: {manifest_json_path}")
    print(f"Manifest SHA-256: {manifest_sha256}")
    print(f"Delivered ZIP SHA-256: {zip_sha256} (UNTOUCHED)")
    print(f"Owner Receipt: Chat 528864559 -> message_id {receipts.get('528864559')}")
    print(f"Brother Receipt: Chat 5535435580 -> message_id {receipts.get('5535435580')}")
    print(f"==========================================")

if __name__ == '__main__':
    main()
