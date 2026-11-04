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
    source_dir = '/tmp/m14_postmerge_evidence'
    zip_path = '/tmp/Round14_M14_PostMerge_VPS_Acceptance_Evidence.zip'

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
        "🚀 *YJAutoPostOnX — M14 Post-Merge VPS Deployment & Non-Posting Evidence*\n"
        "• Merged Base: 21c44df (PR #27 into main)\n"
        "• Docs PR: #28 (Branch: docs/m14-post-merge-vps-acceptance)\n"
        "• Service: yj-telegram-bot.service ACTIVE (PID 2581192)\n"
        "• Safety Invariants: 0 Live POST | cycleState: stopped | 0 Leases\n"
        "• Restricted Accounts: 3 Disabled (@kaniabq, @marcosvhv, @menalobq)\n"
        "• Quarantine: 30 Ambiguous Items Intact | 0 Production Settle (--apply)\n"
        "• Offline Tests: 207/207 Python PASS (0.81s) | 69/69 M14 Targeted PASS (1.21s)\n"
        "• Rollback Ready: Standalone backup at /root/.backup_yj_autopost_m14_postmerge_20261104"
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
        "manifest_type": "YJAutoPostOnX_M14_PostMerge_VPS_Acceptance_Delivery_Manifest",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "delivered_archive": {
            "filename": os.path.basename(zip_path),
            "size_bytes": zip_size,
            "sha256": zip_sha256
        },
        "git_provenance": {
            "merged_main_sha": "21c44df33b8118f91b48e38753fa1006a50c328c",
            "merged_pr_number": 27,
            "docs_pr_number": 28,
            "docs_branch": "docs/m14-post-merge-vps-acceptance",
            "docs_head_sha": "fcd949179679fe266c1e95e925b426ee1ee4e815"
        },
        "production_service_state": {
            "unit": "yj-telegram-bot.service",
            "active": True,
            "main_pid": 2581192,
            "cycle_state": "stopped",
            "active_session_leases": 0,
            "live_posts_count": 0,
            "quarantined_items_count": 30,
            "item_53d0_state": "ambiguous",
            "disabled_accounts": ["kaniabq", "marcosvhv", "menalobq"]
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

    manifest_json_path = '/tmp/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.json'
    with open(manifest_json_path, 'w', encoding='utf-8') as f:
        json.dump(manifest_data, f, indent=2)

    manifest_bytes = pathlib.Path(manifest_json_path).read_bytes()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()

    manifest_md_path = '/tmp/Round14_M14_PostMerge_VPS_Acceptance_Delivery_Manifest.md'
    with open(manifest_md_path, 'w', encoding='utf-8') as f:
        f.write(f"""# YJAutoPostOnX — M14 Post-Merge VPS Acceptance Delivery Manifest

- **Delivered Archive:** `{os.path.basename(zip_path)}`
- **Archive Size:** `{zip_size} bytes`
- **Archive SHA-256:** `{zip_sha256}` *(Byte-for-byte untouched)*
- **Manifest SHA-256:** `{manifest_sha256}`
- **Delivered To:**
  - Owner (`528864559`): `message_id {receipts.get('528864559')}` (`ok: true`)
  - Brother (`5535435580`): `message_id {receipts.get('5535435580')}` (`ok: true`)
- **Git Provenance:**
  - Deployed Main Commit: `21c44df33b8118f91b48e38753fa1006a50c328c`
  - Docs PR #28: https://github.com/yjlvfe/YJAutoPostOnX/pull/28
- **Production Invariants:**
  - Service Active: PID 2581192
  - `cycleState`: `stopped`
  - Active Session Leases: 0
  - Live X POSTs: 0
  - Quarantined Ambiguous Items: 30
""")

    print(f"\n==========================================")
    print(f"DELIVERY MANIFEST CREATED (SEPARATE FROM ZIP)")
    print(f"Manifest JSON: {manifest_json_path}")
    print(f"Manifest SHA-256: {manifest_sha256}")
    print(f"Delivered ZIP SHA-256: {zip_sha256} (UNTOUCHED)")
    print(f"Owner Receipt: Chat 528864559 -> message_id {receipts.get('528864559')}")
    print(f"Brother Receipt: Chat 5535435580 -> message_id {receipts.get('5535435580')}")
    print(f"==========================================")

if __name__ == '__main__':
    main()
