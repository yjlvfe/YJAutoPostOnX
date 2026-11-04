"""Unit tests for DirectSession identity verification, POST fallback prohibition, cookies, and pdeathsig."""
from __future__ import annotations

import asyncio
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

ROOT_BOT = pathlib.Path(__file__).resolve().parents[2]
for venv_root in (ROOT_BOT / '.venv-direct-x', pathlib.Path('/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x')):
    try:
        site_dirs = list(venv_root.glob('lib/python*/site-packages'))
    except OSError:
        continue
    for sp in site_dirs:
        if str(sp) not in sys.path:
            sys.path.insert(0, str(sp))
for p in (str(ROOT_BOT / 'python'), str(ROOT_BOT / 'test' / 'fixtures')):
    if p not in sys.path:
        sys.path.insert(0, p)

import direct_x_bridge as bridge  # type: ignore[import-not-found]
from fake_twikit_client import SpecLockedMockClient  # type: ignore[import-not-found]


class Test02IdentityAndTransport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sleep_patcher = patch('asyncio.sleep', new_callable=AsyncMock)
        self.mock_sleep = self.sleep_patcher.start()

    async def asyncTearDown(self):
        self.sleep_patcher.stop()

    async def test_p03_identity_verifies_live_user_state_even_when_use_cache_true_py_raw_01(self):
        # PY-RAW-01 / FINDING-007: Even when use_cache=True and twid matches userId,
        # DirectSession.identity() MUST verify live authenticated session state (user_state / settings)
        # so a suspended or CAPTCHA-locked account is never reported as authenticated!
        client_suspended = SpecLockedMockClient(
            user_id='100001',
            screen_name='testuser',
            user_state='suspended',
        )
        session_suspended = bridge.DirectSession(
            client_suspended,
            {'id': 'acc-1', 'username': 'testuser', 'userId': '100001', 'use_cache': True},
        )
        with self.assertRaises( Exception ) as ctx:
            await session_suspended.identity()
        self.assertEqual(getattr(ctx.exception, 'account_failure', None), 'banned')
        self.assertGreaterEqual(
            client_suspended.v11.user_state_calls,
            1,
            'PY-RAW-01: v11.user_state() must be called even when use_cache=True',
        )

        # Locked / challenge user_state with use_cache=True must raise captcha (code 326)
        client_locked = SpecLockedMockClient(
            user_id='100001',
            screen_name='testuser',
            user_state='locked',
        )
        session_locked = bridge.DirectSession(
            client_locked,
            {'id': 'acc-1', 'username': 'testuser', 'userId': '100001', 'use_cache': True},
        )
        with self.assertRaises(Exception) as ctx_lock:
            await session_locked.identity()
        self.assertEqual(getattr(ctx_lock.exception, 'account_failure', None), 'captcha')

    async def test_p03_get_user_by_id_account_failure_propagates_and_never_swallowed_py_raw_03(self):
        # PY-RAW-03: If settings() fails and fallback get_user_by_id raises an exception with account_failure,
        # it must propagate and NEVER return authenticated: True!
        client = SpecLockedMockClient(user_id='100001', screen_name='testuser', user_state='normal')
        settings_err = Exception('Settings 404')
        setattr(settings_err, 'http_status', 404)
        client.v11.settings_side_effect = settings_err

        ban_err = Exception('UserUnavailable: User has been suspended')
        setattr(ban_err, 'account_failure', 'banned')
        client.get_user_by_id_side_effect = ban_err

        session = bridge.DirectSession(
            client,
            {'id': 'acc-1', 'username': 'testuser', 'userId': '100001', 'use_cache': False},
        )
        with self.assertRaises(Exception) as ctx:
            await session.identity()
        self.assertEqual(
            getattr(ctx.exception, 'account_failure', None),
            'banned',
            'PY-RAW-03: get_user_by_id exception carrying account_failure must never be swallowed as authenticated',
        )

    async def test_p04_only_socks_transport_forbids_post_fallback_on_curl_error_py_raw_02(self):
        # PY-RAW-02 / FINDING-001: Non-idempotent POST requests must NEVER fall back to httpx
        # even if the curl_cffi exception string contains "before send" or curl_code=7!
        import httpx

        client = bridge.new_client('socks5h://127.0.0.1:18801')
        try:
            transport = client.http._transport
            httpx_fallback_mock = AsyncMock(
                return_value=httpx.Response(status_code=200, json={'ok': True})
            )
            transport.transport.handle_async_request = httpx_fallback_mock

            class FakeCurlSession:
                async def request(self, **kwargs):
                    err = RuntimeError('Connection reset before send on CreateTweet')
                    setattr(err, 'code', 7)
                    raise err

                async def close(self):
                    pass

            transport._curl_session = FakeCurlSession()
            # Ensure is_patched evaluates False so _curl_session is exercised
            del transport.transport.handle_async_request.side_effect
            del transport.transport.handle_async_request.mock_calls
            transport.transport.handle_async_request = self._make_plain_callable(httpx_fallback_mock)

            post_req = httpx.Request('POST', 'https://x.com/i/api/graphql/abc/CreateTweet', content=b'{"text":"hi"}')
            with self.assertRaises(RuntimeError):
                await transport.handle_async_request(post_req)
            self.assertEqual(
                httpx_fallback_mock.call_count,
                0,
                'PY-RAW-02: POST request must NEVER fall back to httpx on curl_cffi failure',
            )

            # Non-allowlisted host is blocked with proxy_destination_denied
            bad_req = httpx.Request('GET', 'https://example.com/test')
            with self.assertRaises(ValueError) as ctx_host:
                await transport.handle_async_request(bad_req)
            self.assertEqual(str(ctx_host.exception), 'proxy_destination_denied')
        finally:
            await client.http.aclose()

    @staticmethod
    def _make_plain_callable(async_mock):
        async def _plain(request):
            return await async_mock(request)
        return _plain

    def test_p04_cookie_1mib_cap_and_symlink_rejection_and_pdeathsig_py_raw_06(self):
        with tempfile.TemporaryDirectory(prefix='yj-bot-py-') as tmpdir:
            # 1. > 1 MiB cookie content rejected with cookie_size
            oversized = json.dumps({'auth_token': 'a' * 1_050_000, 'ct0': 'b' * 32})
            with self.assertRaises(ValueError) as ctx_size:
                bridge.parse_cookies(oversized)
            self.assertEqual(str(ctx_size.exception), 'cookie_size')

            # 2. Symlinked cookie file rejected by O_NOFOLLOW
            real_cookie = os.path.join(tmpdir, 'real.cookies')
            with open(real_cookie, 'w', encoding='utf-8') as f:
                json.dump({'auth_token': 'tok', 'ct0': 'csrf'}, f)
            sym_cookie = os.path.join(tmpdir, 'sym.cookies')
            os.symlink(real_cookie, sym_cookie)
            with self.assertRaises(OSError):
                bridge.read_cookies(sym_cookie)

            # 3. PY-RAW-06: Parent-death check exits when ppid == 1
            if hasattr(bridge, '_set_parent_death_signal'):
                with patch('os.getppid', return_value=1):
                    with self.assertRaises(SystemExit) as ctx_exit:
                        bridge._set_parent_death_signal()
                    self.assertEqual(ctx_exit.exception.code, 1)


if __name__ == '__main__':
    unittest.main()
