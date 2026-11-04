import os
import sys
import json
import pathlib
import hashlib
import urllib.request
import zipfile

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
    source_dir = '/tmp/m14_round4_evidence'
    zip_path = '/tmp/Round14_M14_PR27_Review_Round4_Evidence.zip'

    # Build initial zip
    build_zip(source_dir, zip_path)
    file_bytes = pathlib.Path(zip_path).read_bytes()
    sha256 = hashlib.sha256(file_bytes).hexdigest()
    print(f"Archive built: {zip_path} ({len(file_bytes)} bytes, SHA-256: {sha256})")

    env = load_env('/root/Projects/YJAutoPostOnX/Bot/.env.local')
    token = env.get('TELEGRAM_BOT_TOKEN')
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN not found in .env.local", file=sys.stderr)
        sys.exit(1)

    caption = (
        "🛡️ *YJAutoPostOnX — M14 / PR #27 Review Round 4 Evidence Package*\n"
        "• PR: #27 (Head: 55f3498 | Review: 6611728745)\n"
        "• Status: ALL Round 4 Review Blockers Resolved\n"
        "• P0-A: Runner CAPTCHA wired to durable alerting; code 326 halts without POST\n"
        "• P0-B: Verified API receipts required; per-chat SQLite tracking & partial retry\n"
        "• P0-C: Routine unverified checks preserve challenge state & checkGeneration\n"
        "• P1-D: Atomic POSIX rename reclamation prevents multi-process lock stealing\n"
        "• P1-E: Complete raw logs: 207/207 Python, 450/450 Node.js (150 suites) PASS\n"
        "• GitHub CI: 5/5 Checks PASS | Production Gated"
    )

    targets = ['528864559', '5535435580']
    receipts = {}
    raw_responses = {}
    for chat_id in targets:
        print(f"Dispatching evidence ZIP to Telegram chat {chat_id}...")
        res = send_telegram_document(token, chat_id, zip_path, caption)
        raw_responses[chat_id] = res
        if res.get('ok'):
            msg_id = res.get('result', {}).get('message_id')
            receipts[chat_id] = msg_id
            print(f"  ✓ Delivered to {chat_id}: message_id={msg_id}")
        else:
            print(f"  ✗ Delivery failed to {chat_id}: {res}", file=sys.stderr)
            sys.exit(1)

    # Save raw responses and update zip for forensic record
    receipt_file = os.path.join(source_dir, 'telegram_delivery_receipts.json')
    with open(receipt_file, 'w', encoding='utf-8') as f:
        json.dump(raw_responses, f, indent=2)

    build_zip(source_dir, zip_path)
    final_bytes = pathlib.Path(zip_path).read_bytes()
    final_sha256 = hashlib.sha256(final_bytes).hexdigest()
    print(f"\nFinal Archive with receipts: {zip_path} ({len(final_bytes)} bytes, SHA-256: {final_sha256})")

    print("\nDelivery Receipts Summary:")
    for cid, mid in receipts.items():
        print(f"  - Chat ID {cid}: message_id {mid} (ok: true)")

if __name__ == '__main__':
    main()
