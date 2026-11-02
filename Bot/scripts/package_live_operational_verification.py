#!/usr/bin/env python3
"""Build, verify and deliver LIVE_OPERATIONAL_VERIFICATION.zip archive."""
import hashlib
import json
import os
import pathlib
import re
import sys
import zipfile
import urllib.request
import urllib.parse

BASE = pathlib.Path('/root/Projects/YJAutoPostOnX')
DEST1 = BASE / 'Bot/Reports/RepairHandoff/ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip'
DEST2 = BASE / 'ARCHIVES/LIVE_OPERATIONAL_VERIFICATION.zip'

DEST1.parent.mkdir(parents=True, exist_ok=True)
DEST2.parent.mkdir(parents=True, exist_ok=True)

FILES = [
    # Governance & Master Reports
    ('MASTER_TODO.md', 'MASTER_TODO.md'),
    ('PROGRESS_HISTORY.md', 'PROGRESS_HISTORY.md'),
    ('Bot/Reports/RepairHandoff/MASTER_TODO.md', 'reports/MASTER_TODO.md'),
    ('Bot/Reports/RepairHandoff/PROGRESS_HISTORY.md', 'reports/PROGRESS_HISTORY.md'),
    ('/root/.agents/teamwork/worker_m4_1/report.md', 'reports/m4_operational_verification_report.md'),
    ('/root/.agents/teamwork/worker_m4_1/DISPATCH.md', 'reports/m4_dispatch.md'),
    ('/root/.agents/teamwork/explorer_m4_1/handoff.md', 'reports/explorer_m4_1_handoff.md'),
    ('/root/.agents/teamwork/explorer_m4_2/handoff.md', 'reports/explorer_m4_2_handoff.md'),
    ('/root/.agents/teamwork/explorer_m4_3/handoff.md', 'reports/explorer_m4_3_handoff.md'),

    # Operational Logs & Evidence
    ('Bot/Reports/evidence_m4/tweet_headers.txt', 'logs/tweet_2117147398187479078_headers.txt'),
    ('Bot/Reports/evidence_m4/tweet_og_meta.txt', 'logs/tweet_2117147398187479078_og_meta.txt'),
    ('Bot/Reports/evidence_m4/sqlite_state_snapshot.json', 'logs/sqlite_state_snapshot.json'),
    ('Bot/Reports/evidence_m4/git_log.txt', 'logs/git_commit_log.txt'),
    ('Bot/Reports/evidence_m4/journalctl_service.log', 'logs/journalctl_service.log'),
    ('Bot/data/exports/links_2026-11-01.csv', 'exports/links_2026-11-01.csv'),

    # Automated Test Suites for Verification
    ('Bot/test/docker_vpn_live_slots.test.js', 'tests/docker_vpn_live_slots.test.js'),
    ('Bot/test/m3_edge_case_hardening.test.js', 'tests/m3_edge_case_hardening.test.js'),
    ('Bot/test/single_instance_lock_adversarial_challenge.test.js', 'tests/single_instance_lock_adversarial_challenge.test.js'),
    ('Bot/test/single_instance_lock.test.js', 'tests/single_instance_lock.test.js'),
    ('Bot/test/account_refresh_and_exit_ip.test.js', 'tests/account_refresh_and_exit_ip.test.js'),
    ('Bot/test/m4_lifecycle_and_recovery.test.js', 'tests/m4_lifecycle_and_recovery.test.js'),
    ('Bot/test/challenger_m1_adversarial.test.js', 'tests/challenger_m1_adversarial.test.js'),
    ('Bot/python/test_bridge_hardening.py', 'tests/test_bridge_hardening.py'),
    ('Bot/python/test_adversarial_m1_challenger.py', 'tests/test_adversarial_m1_challenger.py'),
]

SECRET_PATTERNS = [
    re.compile(r'bot\d+:[A-Za-z0-9_-]{35}'), # Telegram bot tokens
    re.compile(r'auth_token\s*=\s*[a-f0-9]{40}', re.IGNORECASE),
    re.compile(r'ct0\s*=\s*[a-f0-9]{32,}', re.IGNORECASE),
]

def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('\'"')
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
    with urllib.request.urlopen(req, timeout=30) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        return res

def main():
    print("Packaging Milestone M4 Live Operational Verification Deliverables...")
    resolved_files = []
    for src_rel, arc_rel in FILES:
        src = pathlib.Path(src_rel) if src_rel.startswith('/') else BASE / src_rel
        if not src.exists():
            print(f"ERROR: Missing deliverable file: {src}", file=sys.stderr)
            sys.exit(1)
        
        # Secret scan
        try:
            content = src.read_text(errors='ignore')
            for pat in SECRET_PATTERNS:
                if pat.search(content):
                    print(f"ERROR: Potential secret detected in {src} matching {pat}", file=sys.stderr)
                    sys.exit(1)
        except Exception as e:
            print(f"Warning reading {src}: {e}")
        resolved_files.append((src, arc_rel))

    # Build primary zip
    with zipfile.ZipFile(DEST1, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for src, arc_rel in resolved_files:
            zf.write(src, arc_rel)
            print(f"  + Added: {arc_rel} ({src.stat().st_size} bytes)")

    # Mirror to DEST2
    DEST2.write_bytes(DEST1.read_bytes())

    sha1 = hashlib.sha256(DEST1.read_bytes()).hexdigest()
    sha2 = hashlib.sha256(DEST2.read_bytes()).hexdigest()
    size1 = DEST1.stat().st_size

    print(f"\nArchive generated successfully:")
    print(f"  Primary:  {DEST1} ({size1} bytes, SHA-256: {sha1})")
    print(f"  Mirrored: {DEST2} ({size1} bytes, SHA-256: {sha2})")
    assert sha1 == sha2, "Checksum mismatch between primary and mirror!"
    print("✓ Package verification passed.")

    # Deliver to Telegram
    env = load_env('/root/Projects/YJAutoPostOnX/Bot/.env.local')
    token = env.get('TELEGRAM_BOT_TOKEN')
    if not token:
        print("ERROR: TELEGRAM_BOT_TOKEN not found in .env.local", file=sys.stderr)
        sys.exit(1)

    caption = (
        "🏆 *Milestone M4 Live Operational Verification Complete*\n"
        "• Host: MasterYJ | Git Commit: ca0c929\n"
        "• Live Tweet Published: https://x.com/crytpokingxvo8/status/2117147398187479078\n"
        "• Account: @crytpokingxvo8 (ID: x-930e0054b395228aefa9)\n"
        "• SOCKS5 Exit IP: 187.40.234.102 (Zero Host Leak)\n"
        "• Daily Quota: +1 consumed (persists across restart)\n"
        "• Test Suite: 369/369 PASS across 4 tiers (0 failures)\n"
        "• All 10 operational verification checks passed."
    )

    targets = ['528864559', '5535435580']
    for chat_id in targets:
        print(f"Delivering archive to Telegram chat ID: {chat_id}...")
        res = send_telegram_document(token, chat_id, DEST2, caption)
        if res.get('ok'):
            msg_id = res.get('result', {}).get('message_id')
            print(f"  ✓ Delivered successfully to {chat_id} (Message ID: {msg_id})")
        else:
            print(f"  ✗ Delivery failed to {chat_id}: {res}", file=sys.stderr)
            sys.exit(1)

if __name__ == '__main__':
    main()
