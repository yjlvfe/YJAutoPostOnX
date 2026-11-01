#!/usr/bin/env python3
"""Build and verify PHASE_P1 deliverable archive."""
import hashlib
import os
import pathlib
import re
import sys
import zipfile

BASE = pathlib.Path('/root/Projects/YJAutoPostOnX')
DEST1 = BASE / 'Bot/Reports/RepairHandoff/ARCHIVES/PHASE_P1.zip'
DEST2 = BASE / 'ARCHIVES/PHASE_P1.zip'

DEST1.parent.mkdir(parents=True, exist_ok=True)
DEST2.parent.mkdir(parents=True, exist_ok=True)

FILES = [
    # Repaired source code
    ('Bot/python/direct_x_bridge.py', 'Bot/python/direct_x_bridge.py'),
    ('Bot/python/direct_x_compat.py', 'Bot/python/direct_x_compat.py'),
    ('Bot/python/README.md', 'Bot/python/README.md'),
    ('Bot/python/test_normalize_urls.py', 'Bot/python/test_normalize_urls.py'),
    ('Bot/requirements-direct-x.txt', 'Bot/requirements-direct-x.txt'),
    ('Bot/src/runner.js', 'Bot/src/runner.js'),
    ('Bot/src/directX.js', 'Bot/src/directX.js'),
    ('Bot/src/forensicLogger.js', 'Bot/src/forensicLogger.js'),
    ('Bot/src/queue.js', 'Bot/src/queue.js'),

    # Test harness & Standalone proofs
    ('TEST_RUNNER/run_suite.py', 'TEST_RUNNER/run_suite.py'),
    ('TEST_RUNNER/bridge_worker.py', 'TEST_RUNNER/bridge_worker.py'),
    ('TEST_RUNNER/node_worker.js', 'TEST_RUNNER/node_worker.js'),
    ('TEST_RUNNER/fake_ipc.py', 'TEST_RUNNER/fake_ipc.py'),
    ('TEST_RUNNER/package_verify.py', 'TEST_RUNNER/package_verify.py'),
    ('TEST_RUNNER/transport_worker.py', 'TEST_RUNNER/transport_worker.py'),
    ('scripts/verify_p1_004_dedup.js', 'scripts/verify_p1_004_dedup.js'),
    ('scripts/verify_p1_005_queue_flow.js', 'scripts/verify_p1_005_queue_flow.js'),

    # Test Results & Execution Evidence
    ('TEST_RESULTS.json', 'TEST_RESULTS.json'),
    ('Bot/Reports/RepairHandoff/PHASE_P1/TEST_RESULTS.md', 'Reports/TEST_RESULTS.md'),
    ('Bot/Reports/RepairHandoff/PHASE_P1/phase_p1_fixes.patch', 'Reports/phase_p1_fixes.patch'),

    # Governance & Documentation
    ('MASTER_TODO.md', 'MASTER_TODO.md'),
    ('PROGRESS_HISTORY.md', 'PROGRESS_HISTORY.md'),
    ('Bot/Reports/RepairHandoff/PHASE_P1/REPORT.md', 'Reports/REPORT.md'),
    ('Bot/Reports/RepairHandoff/PHASE_P1/GIT_COMMITS.md', 'Reports/GIT_COMMITS.md'),
]

SECRET_PATTERNS = [
    re.compile(r'bot\d+:[A-Za-z0-9_-]{35}'), # Telegram bot tokens
    re.compile(r'auth_token\s*=\s*[a-f0-9]{40}', re.IGNORECASE),
    re.compile(r'ct0\s*=\s*[a-f0-9]{32,}', re.IGNORECASE),
]

def main():
    print("Packaging Phase P1 Deliverables...")
    for src_rel, _ in FILES:
        src = BASE / src_rel
        if not src.exists():
            print(f"ERROR: Missing required deliverable file: {src}", file=sys.stderr)
            sys.exit(1)
        
        # Secret scan
        try:
            content = src.read_text(errors='ignore')
            for pat in SECRET_PATTERNS:
                if pat.search(content):
                    print(f"ERROR: Potential secret detected in {src} matching {pat}", file=sys.stderr)
                    sys.exit(1)
        except Exception:
            pass

    # Build primary zip
    with zipfile.ZipFile(DEST1, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for src_rel, arc_rel in FILES:
            src = BASE / src_rel
            zf.write(src, arc_rel)
            print(f"  + Added: {arc_rel} ({src.stat().st_size} bytes)")

    # Mirror to DEST2
    DEST2.write_bytes(DEST1.read_bytes())

    # Checksums
    sha1 = hashlib.sha256(DEST1.read_bytes()).hexdigest()
    sha2 = hashlib.sha256(DEST2.read_bytes()).hexdigest()
    size1 = DEST1.stat().st_size

    print(f"\nArchive successfully generated:")
    print(f"  Primary:  {DEST1} ({size1} bytes, SHA-256: {sha1})")
    print(f"  Mirrored: {DEST2} ({size1} bytes, SHA-256: {sha2})")
    assert sha1 == sha2, "Checksum mismatch between primary and mirror!"
    print("✓ Package verification passed.")

if __name__ == '__main__':
    main()
