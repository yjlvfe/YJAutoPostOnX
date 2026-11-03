'use strict';
import os
import sys
import json
import pathlib
import hashlib
import urllib.request

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

def main():
    zip_path = '/tmp/Round14_M14_PR27_Review_Round2_Evidence.zip'
    if not os.path.exists(zip_path):
        print(f"ERROR: {zip_path} not found!", file=sys.stderr)
        sys.exit(1)

    file_bytes = pathlib.Path(zip_path).read_bytes()
    sha256 = hashlib.sha256(file_bytes).hexdigest()
    size = len(file_bytes)
    print(f"Archive: {zip_path} ({size} bytes, SHA-256: {sha256})")

    env = load_env('/root/Projects/YJAutoPostOnX/Bot/.env.local')
    token = env.get('TELEGRAM_BOT_TOKEN')
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN not found in .env.local", file=sys.stderr)
        sys.exit(1)

    caption = (
        "🛡️ *YJAutoPostOnX — M14 / PR #27 Review Round 2 Evidence Package*\n"
        "• PR: #27 (Head: 4373a5e)\n"
        "• Status: ALL Round 2 Review Blockers Resolved\n"
        "• P0-A: Quota baseline anchored; 10->11 bug eliminated (CAS)\n"
        "• P0-B: Outbox fsync before ACK; _withLogLock file serialization\n"
        "• P0-C: CAS stale CAPTCHA defense against injected event B\n"
        "• P1-D: Session ceiling hardened; /proc visibility fail-closed\n"
        "• P1-E: check_session verified local-only; durable alert dedup\n"
        "• Tests: 207/207 Python, 434/434 Node (141 suites) PASS (100%)\n"
        "• GitHub CI: 5/5 Checks PASS | Production Apply Gated"
    )

    targets = ['528864559', '5535435580']
    receipts = {}
    for chat_id in targets:
        print(f"Dispatching evidence ZIP to Telegram chat {chat_id}...")
        res = send_telegram_document(token, chat_id, zip_path, caption)
        if res.get('ok'):
            msg_id = res.get('result', {}).get('message_id')
            receipts[chat_id] = msg_id
            print(f"  ✓ Delivered to {chat_id}: message_id={msg_id}")
        else:
            print(f"  ✗ Delivery failed to {chat_id}: {res}", file=sys.stderr)
            sys.exit(1)

    print("\nDelivery Receipts Summary:")
    for cid, mid in receipts.items():
        print(f"  - Chat ID {cid}: message_id {mid} (ok: true)")

if __name__ == '__main__':
    main()
