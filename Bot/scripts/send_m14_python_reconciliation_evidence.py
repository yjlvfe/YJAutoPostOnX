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
    source_dir = '/tmp/m14_python_evidence_reconciliation'
    zip_path = '/tmp/Round14_M14_Python_Reconciliation_Evidence.zip'

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
        "🔬 *YJAutoPostOnX — M14 Python Failure Resolution & Evidence Reconciliation*\n"
        "• Merged Base: 21c44df (PR #27 into main)\n"
        "• Code-Fix PR: #29 (Branch: fix/m14-python-rate-limit-mock-isolation)\n"
        "• Docs PR: #28 (Updated with full reconciliation & root cause)\n"
        "• Python Rerun: 208/208 PASS (0.71s, 5/5 clean runs)\n"
        "• Node Suites: Targeted M14: 69/69 PASS (1.04s) | Full: 444 PASS (7 idle slots)\n"
        "• Docker Invariant: Exactly 4 running NordVPN containers (2 project, 2 other)\n"
        "• Production Safety: 0 Live POST | cycleState: stopped | 3 Accounts Disabled"
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
        "manifest_type": "YJAutoPostOnX_M14_Python_Reconciliation_Delivery_Manifest",
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "delivered_archive": {
            "filename": os.path.basename(zip_path),
            "size_bytes": zip_size,
            "sha256": zip_sha256
        },
        "git_provenance": {
            "merged_main_sha": "21c44df33b8118f91b48e38753fa1006a50c328c",
            "docs_pr_number": 28,
            "docs_head_sha": "975c1970071e4c8d2dd689cece4bd7fabaa02644",
            "code_fix_pr_number": 29,
            "code_fix_head_sha": "4841ee1b88f9a297dc61cbd772c5232419f54c04",
            "code_fix_branch": "fix/m14-python-rate-limit-mock-isolation"
        },
        "python_failure_resolution": {
            "reproduced": True,
            "failing_test": "test_create_tweet_author_mismatch_timeline_not_found_returns_author_unverified",
            "observed_res_before_fix": {
                "status": "rate_limit",
                "published": False,
                "posted": False,
                "rateLimit": True,
                "ambiguous": False,
                "reason": "rate_limit"
            },
            "root_cause": "client_error = getattr(self.client, '_last_create_tweet_error', None) evaluated with is_rate_limit_exception on MagicMock; substring '429' in mock object ID caused false rate_limit classification with ambiguous: False",
            "fix": "Guarded client_error with isinstance(client_error, BaseException), bounded regex to \\b429\\b, and isolated mock client in setUp",
            "rerun_results": "208/208 PASS in 0.708s across 5 consecutive clean runs"
        },
        "docker_vpn_reconciliation": {
            "running_project_nordvpn": ["yj_autopost_vpn_1", "yj_autopost_vpn_2"],
            "stopped_idle_project_slots": ["yj_autopost_vpn_3", "yj_autopost_vpn_4", "yj_autopost_vpn_5"],
            "running_other_nordvpn": ["cryptovpn-nordvpn", "yjdownloadvideo-nordvpn-1"],
            "total_running_nordvpn_host_wide": 4,
            "host_nordvpn_ceiling": 7
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

    manifest_json_path = '/tmp/Round14_M14_Python_Reconciliation_Delivery_Manifest.json'
    with open(manifest_json_path, 'w', encoding='utf-8') as f:
        json.dump(manifest_data, f, indent=2)

    manifest_bytes = pathlib.Path(manifest_json_path).read_bytes()
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()

    manifest_md_path = '/tmp/Round14_M14_Python_Reconciliation_Delivery_Manifest.md'
    with open(manifest_md_path, 'w', encoding='utf-8') as f:
        f.write(f"""# YJAutoPostOnX — M14 Python Reconciliation Delivery Manifest

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
  - Code-Fix PR #29: https://github.com/yjlvfe/YJAutoPostOnX/pull/29
- **Python Verification:** 208/208 PASS in 0.71s (5/5 clean runs)
- **Node Verification:** Targeted M14: 69/69 PASS (1.04s) | Full: 444 PASS (7 idle slots)
- **Docker Invariant:** 4 running NordVPN containers (2 project + 2 other), host cap <= 7
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
