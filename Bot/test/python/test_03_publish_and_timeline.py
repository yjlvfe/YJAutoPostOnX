"""Unit tests for DirectSession two-phase publish fence, post-dispatch ambiguity, and Snowflake timeline attribution."""
from __future__ import annotations

import pathlib
import sys
import time
import unittest
from unittest.mock import AsyncMock, patch

ROOT_BOT = pathlib.Path(__file__).resolve().parents[2]
for venv_root in (ROOT_BOT / '.venv-direct-x', pathlib.Path('/root/Projects/YJAutoPostOnX/Bot/.venv-direct-x')):
    for sp in venv_root.glob('lib/python*/site-packages'):
        if str(sp) not in sys.path:
            sys.path.insert(0, str(sp))
for p in (str(ROOT_BOT / 'python'), str(ROOT_BOT / 'test' / 'fixtures')):
    if p not in sys.path:
        sys.path.insert(0, p)

import direct_x_bridge as bridge  # type: ignore[import-not-found]
from fake_twikit_client import FakeTweet, SpecLockedMockClient, make_snowflake_id  # type: ignore[import-not-found]


class Test03PublishAndTimeline(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sleep_patcher = patch('asyncio.sleep', new_callable=AsyncMock)
        self.mock_sleep = self.sleep_patcher.start()

    async def asyncTearDown(self):
        self.sleep_patcher.stop()

    async def test_p06_two_phase_dispatch_handshake_aborts_when_not_acknowledged(self):
        client = SpecLockedMockClient(user_id='100001', screen_name='testuser')
        session = bridge.DirectSession(
            client,
            {'id': 'acc-1', 'username': 'testuser', 'userId': '100001'},
        )

        async def reject_dispatch():
            return False

        res = await session.publish('Hello world', reject_dispatch)
        self.assertEqual(res['status'], 'ambiguous')
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'dispatch_not_acknowledged')
        self.assertEqual(client.create_tweet_calls, 0, 'create_tweet must NEVER be called if dispatch_ack is not True')

    async def test_p06_post_dispatch_non_confirmed_outcomes_forced_ambiguous_true_retryable_false_py_raw_04_xt_05(self):
        # PY-RAW-04 / XT-05: Once dispatch_ack has been received, ANY non-confirmed outcome
        # (including HTTP 429 rate_limit, timeline 429, network_proxy_error, or duplicate_content rejection)
        # MUST return ambiguous: True and retryable: False!
        for case_name, exc_factory in (
            ('http_429_on_create_tweet', lambda: self._make_exc('HTTP 429 Too Many Requests', http_status=429, account_failure='rate_limit')),
            ('network_proxy_drop', lambda: self._make_exc('SOCKS5 proxy connection reset by peer', account_failure='network_proxy_error')),
            ('duplicate_tweet_187', lambda: self._make_exc('Status is a duplicate', code=187)),
        ):
            with self.subTest(case=case_name):
                client = SpecLockedMockClient(user_id='100001', screen_name='testuser')
                client.create_tweet_side_effect = exc_factory()
                client.timeline_tweets = []
                session = bridge.DirectSession(
                    client,
                    {'id': 'acc-1', 'username': 'testuser', 'userId': '100001'},
                )
                res = await session.publish('Post-dispatch test text', lambda: True)
                self.assertFalse(res.get('published'), f'{case_name}: published must be False')
                self.assertTrue(
                    res.get('ambiguous'),
                    f'{case_name}: post-dispatch non-confirmed result MUST have ambiguous=True (PY-RAW-04/XT-05), got {res}',
                )
                self.assertFalse(
                    res.get('retryable', False),
                    f'{case_name}: post-dispatch non-confirmed result MUST have retryable=False (PY-RAW-04/XT-05), got {res}',
                )

    @staticmethod
    def _make_exc(msg, http_status=None, account_failure=None, code=None):
        e = RuntimeError(msg)
        if http_status is not None:
            setattr(e, 'http_status', http_status)
        if account_failure is not None:
            setattr(e, 'account_failure', account_failure)
        if code is not None:
            setattr(e, 'code', code)
            setattr(e, 'errors', [{'code': code, 'message': msg}])
        return e

    async def test_p05_snowflake_and_created_at_lower_bound_rejects_pre_existing_identical_tweets_xt_01(self):
        # XT-01 / FINDING-002: A tweet with identical normalized text created BEFORE dispatch_started_epoch - 2.0
        # (e.g., 20 minutes or 10 seconds before dispatch) MUST be rejected by verify_timeline!
        now = time.time()
        old_epoch_20m = now - 1200.0  # 20 minutes before dispatch (within old 1800s window, but BEFORE dispatch!)
        old_epoch_10s = now - 10.0    # 10 seconds before dispatch

        for label, old_ts in (('20_minutes_before', old_epoch_20m), ('10_seconds_before', old_epoch_10s)):
            with self.subTest(case=label):
                client = SpecLockedMockClient(user_id='100001', screen_name='testuser')
                client.create_tweet_side_effect = RuntimeError('Socket closed after send')
                old_tid = make_snowflake_id(old_ts)
                client.timeline_tweets = [
                    FakeTweet(
                        tweet_id=old_tid,
                        full_text='Repeated daily market update text',
                        user_id='100001',
                        screen_name='testuser',
                        created_at_epoch=old_ts,
                    )
                ]
                session = bridge.DirectSession(
                    client,
                    {'id': 'acc-1', 'username': 'testuser', 'userId': '100001'},
                )
                res = await session.publish('Repeated daily market update text', lambda: True)
                self.assertFalse(
                    res.get('published'),
                    f'XT-01 ({label}): Pre-existing tweet created before dispatch_started_epoch must NOT be attributed to failed new dispatch!',
                )
                self.assertTrue(res.get('ambiguous'))

        # Positive case: Tweet created AT/AFTER dispatch_started_epoch IS recovered from timeline,
        # and XT-02 preserves accountFailure/xErrorCode from the CreateTweet exception!
        client_ok = SpecLockedMockClient(user_id='100001', screen_name='testuser')
        cap_exc = self._make_exc('Challenge required after post', code=326, account_failure='captcha')
        client_ok.create_tweet_side_effect = cap_exc
        fresh_ts = time.time() + 1.0
        fresh_tid = make_snowflake_id(fresh_ts)
        client_ok.timeline_tweets = [
            FakeTweet(
                tweet_id=fresh_tid,
                full_text='Freshly dispatched tweet text',
                user_id='100001',
                screen_name='testuser',
                created_at_epoch=fresh_ts,
            )
        ]
        session_ok = bridge.DirectSession(
            client_ok,
            {'id': 'acc-1', 'username': 'testuser', 'userId': '100001'},
        )
        res_ok = await session_ok.publish('Freshly dispatched tweet text', lambda: True)
        self.assertTrue(res_ok.get('published'), 'Fresh tweet >= dispatch_started_epoch must be recovered from timeline')
        self.assertTrue(res_ok.get('recoveredFromTimeline'))
        self.assertEqual(res_ok.get('tweetId'), fresh_tid)
        self.assertEqual(res_ok.get('accountFailure'), 'captcha', 'XT-02: accountFailure must be preserved on timeline recovery')
        self.assertEqual(res_ok.get('xErrorCode'), 326, 'XT-02: xErrorCode must be preserved on timeline recovery')


if __name__ == '__main__':
    unittest.main()
