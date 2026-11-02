#!/usr/bin/env python3
"""
Adversarial Empirical Challenge Test Suite for Milestone M1
Focus: 8 Diagnostic Classes, HTTP 429 Rate Limit Fast-Path, Timeline Bypass & Strike Isolation.
"""
import asyncio
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from direct_x_compat import classify_x_account_failure
from direct_x_bridge import (
    DirectSession,
    extract_retry_after_seconds,
    is_rate_limit_exception,
    KNOWN_ACCOUNT_FAILURES,
)


class TestAdversarialDiagnosticClassification(unittest.TestCase):
    """Adversarial stress-testing of classify_x_account_failure across 8 classes and non-failures."""

    def test_class_1_banned_variations(self):
        # Explicit error codes
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 63}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 141}]), 'banned')
        # Extension codes
        self.assertEqual(classify_x_account_failure(errors=[{'extensions': {'code': 64}}]), 'banned')
        # Reason in raw_json
        self.assertEqual(classify_x_account_failure(raw_json={'reason': 'Suspended'}), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'reason': '  suspended  '}), 'banned')
        # Text patterns
        self.assertEqual(classify_x_account_failure(text='Account has been suspended'), 'banned')
        self.assertEqual(classify_x_account_failure(text='User is suspended'), 'banned')
        self.assertEqual(classify_x_account_failure(text='account suspended'), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'message': 'User has been suspended'}), 'banned')

    def test_class_1_banned_adversarial_negatives(self):
        # 'unsuspended' must NEVER trigger 'banned'
        self.assertIsNone(classify_x_account_failure(text='unsuspended'))
        self.assertIsNone(classify_x_account_failure(text='User has been unsuspended.'))
        self.assertIsNone(classify_x_account_failure(text='My account was unsuspended today'))
        self.assertIsNone(classify_x_account_failure(raw_json={'message': 'The user is unsuspended'}))
        # Content talking about banned topics must NEVER trigger 'banned'
        self.assertIsNone(classify_x_account_failure(text='banned'))
        self.assertIsNone(classify_x_account_failure(text='Why was this user banned from the discord?'))
        self.assertIsNone(classify_x_account_failure(text='Crypto update: Bitcoin banned in Nigeria'))
        self.assertIsNone(classify_x_account_failure(text='Many accounts were banned last month'))
        self.assertIsNone(classify_x_account_failure(raw_json={'errors': [{'message': 'Invalid tweet: banned word'}]}))

    def test_class_2_captcha_variations(self):
        # Error codes
        self.assertEqual(classify_x_account_failure(errors=[{'code': 326}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 353}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 399}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 241}]), 'captcha')
        # Bounce location in raw_json and error items
        self.assertEqual(classify_x_account_failure(raw_json={'bounce_location': 'https://twitter.com/account/access'}), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'bounce_location': 'https://twitter.com/account/access'}]), 'captcha')
        # Keywords
        for kw in ('captcha', 'arkose', 'funcaptcha', 'verification_required',
                   'challenge_required', 'temporarily locked', 'unlock your account',
                   'account/access', 'login_verification', 'user is locked', 'account is locked'):
            self.assertEqual(classify_x_account_failure(text=f"Encountered {kw} in response"), 'captcha')

    def test_class_3_cookie_expired_variations(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'cookie_expired')
        for kw in ('token is expired', 'session expired', 'expired token',
                   'cookie expired', 'cookies expired', 'session invalidated',
                   'invalid session', 'invalid or expired token'):
            self.assertEqual(classify_x_account_failure(text=f"Auth error: {kw}"), 'cookie_expired')

    def test_class_4_auth_rejected_variations(self):
        for code in (32, 135, 215, 99, 231):
            self.assertEqual(classify_x_account_failure(errors=[{'code': code}]), 'auth_rejected')
        for kw in ('bad authentication data', 'could not authenticate you',
                   'auth rejected', 'authentication failed', 'unauthorized',
                   'incorrect password', 'account compromised', 'unable to verify credentials'):
            self.assertEqual(classify_x_account_failure(text=f"Direct auth failure: {kw}"), 'auth_rejected')

    def test_class_5_rate_limit_variations(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 88}]), 'rate_limit')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 185}]), 'rate_limit')
        self.assertEqual(classify_x_account_failure(http_status=429), 'rate_limit')
        for kw in ('rate limit', 'rate_limit', 'too many requests',
                   'over capacity', 'over daily status update limit',
                   'exceeded rate limit', 'user is over daily status update limit'):
            self.assertEqual(classify_x_account_failure(text=f"API throttled: {kw}"), 'rate_limit')

    def test_class_6_network_proxy_error_variations(self):
        for kw in ('proxy', 'socks', 'socks5', 'connection refused', 'connection reset',
                   'connection error', 'connecterror', 'timed out', 'timeout',
                   'network unreachable', 'host unreachable', 'name resolution failure',
                   'getaddrinfo failed', 'ssl error', 'remote protocol error', 'network error'):
            self.assertEqual(classify_x_account_failure(text=f"Transport drop: {kw}"), 'network_proxy_error')

    def test_class_7_ambiguous_variations(self):
        for kw in ('ambiguous', 'unconfirmed', 'publish_confirmation_missing',
                   'dispatch_already_attempted', 'eventual consistency'):
            self.assertEqual(classify_x_account_failure(text=f"Verification state: {kw}"), 'ambiguous')

    def test_class_8_unknown_variations(self):
        self.assertEqual(classify_x_account_failure(text='unknown error occurred during operation'), 'unknown')
        self.assertEqual(classify_x_account_failure(text='unspecified failure detected'), 'unknown')

    def test_content_errors_return_none(self):
        """Content/payload errors (duplicate tweet 187, length 186, etc.) must NEVER be classified as account failures."""
        # 187: Status is a duplicate
        self.assertIsNone(classify_x_account_failure(errors=[{'code': 187, 'message': 'Status is a duplicate.'}]))
        self.assertIsNone(classify_x_account_failure(raw_json={'errors': [{'code': 187, 'message': 'Status is a duplicate.'}]}))
        # 186: Tweet too long
        self.assertIsNone(classify_x_account_failure(errors=[{'code': 186, 'message': 'Tweet text is too long.'}]))
        # 385: Reply to deleted tweet
        self.assertIsNone(classify_x_account_failure(errors=[{'code': 385, 'message': 'You attempted to reply to a deleted tweet'}]))
        # 34: Page does not exist
        self.assertIsNone(classify_x_account_failure(errors=[{'code': 34, 'message': 'Sorry, that page does not exist.'}]))

    def test_adversarial_malformed_inputs(self):
        """Edge cases: empty inputs, non-dict, non-list, corrupt datatypes."""
        self.assertIsNone(classify_x_account_failure())
        self.assertIsNone(classify_x_account_failure(raw_json=None, errors=None, text='', http_status=None))
        self.assertIsNone(classify_x_account_failure(raw_json='not-a-dict'))
        self.assertIsNone(classify_x_account_failure(raw_json=12345))
        self.assertIsNone(classify_x_account_failure(errors='not-a-list'))
        self.assertIsNone(classify_x_account_failure(errors=[None, 'string', 99]))
        self.assertIsNone(classify_x_account_failure(errors=[{'code': 'non_int_code'}]))


class TestRateLimitHelperFunctions(unittest.TestCase):
    """Adversarial testing of is_rate_limit_exception and extract_retry_after_seconds."""

    def test_is_rate_limit_exception(self):
        class Http429Err(Exception):
            http_status = 429
        self.assertTrue(is_rate_limit_exception(Http429Err("Request failed")))

        class AccountFailureErr(Exception):
            account_failure = 'rate_limit'
        self.assertTrue(is_rate_limit_exception(AccountFailureErr("Custom rate limit")))

        class Code88Err(Exception):
            code = 88
        self.assertTrue(is_rate_limit_exception(Code88Err("Rate limit exceeded")))

        class Code185Err(Exception):
            error_code = 185
        self.assertTrue(is_rate_limit_exception(Code185Err("Status limit reached")))

        import twikit.errors
        self.assertTrue(is_rate_limit_exception(twikit.errors.TooManyRequests("Rate limited")))

        # Message string detection
        self.assertTrue(is_rate_limit_exception(Exception("HTTP 429 Too Many Requests")))
        self.assertTrue(is_rate_limit_exception(Exception("client rate limit exceeded")))

        # Negative checks
        self.assertFalse(is_rate_limit_exception(Exception("connection reset")))
        self.assertFalse(is_rate_limit_exception(Exception("auth failed")))
        self.assertFalse(is_rate_limit_exception(ValueError("duplicate tweet")))

    def test_extract_retry_after_seconds_clamping_and_headers(self):
        # Attribute retry_after_seconds
        class ExcWithAttr(Exception):
            retry_after_seconds = 120
        self.assertEqual(extract_retry_after_seconds(ExcWithAttr()), 120)

        # Attribute clamped to minimum 60
        class ExcSmall(Exception):
            retry_after_seconds = 10
        self.assertEqual(extract_retry_after_seconds(ExcSmall()), 60)

        # Attribute clamped to maximum 900
        class ExcLarge(Exception):
            retry_after_seconds = 5000
        self.assertEqual(extract_retry_after_seconds(ExcLarge()), 900)

        # Headers retry-after
        class ExcHeader(Exception):
            headers = {'retry-after': '300'}
        self.assertEqual(extract_retry_after_seconds(ExcHeader()), 300)

        # Headers x-rate-limit-reset (epoch diff)
        now = time.time()
        class ExcReset(Exception):
            headers = {'x-rate-limit-reset': str(now + 450)}
        diff = extract_retry_after_seconds(ExcReset())
        self.assertTrue(440 <= diff <= 460)

        # Fallback default clamped
        self.assertEqual(extract_retry_after_seconds(Exception("generic"), default=150), 150)
        self.assertEqual(extract_retry_after_seconds(Exception("generic"), default=30), 60)
        self.assertEqual(extract_retry_after_seconds(Exception("generic"), default=2000), 900)


class TestDirectSessionPublishRateLimitFastPath(unittest.IsolatedAsyncioTestCase):
    """Adversarial tests for DirectSession.publish() under HTTP 429 rate limit."""

    async def asyncSetUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'tester',
            'userId': '12345',
            'use_cache': False
        }
        self.session = DirectSession(self.mock_client, self.account)
        # Seed verified identity
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'tester',
            'userId': '12345'
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_http_429_returns_rate_limit_payload_and_never_calls_verify_timeline(self):
        """CRITICAL: HTTP 429 during create_tweet MUST fast-path return rateLimit: True and NEVER poll timeline."""
        from twikit.errors import TooManyRequests
        err = TooManyRequests("Rate limit exceeded")
        err.http_status = 429
        err.headers = {'retry-after': '180'}
        self.mock_client.create_tweet = AsyncMock(side_effect=err)

        # Spy on verify_timeline
        self.session.verify_timeline = AsyncMock()

        res = await self.session.publish("Adversarial tweet text", dispatch=lambda: True)

        # 1. Timeline verification MUST NOT be invoked
        self.assertEqual(self.session.verify_timeline.await_count, 0, "verify_timeline MUST NEVER be called on HTTP 429")

        # 2. Response dictionary assertions
        self.assertEqual(res['status'], 'rate_limit')
        self.assertFalse(res['published'])
        self.assertFalse(res['posted'])
        self.assertTrue(res['rateLimit'])
        self.assertFalse(res['ambiguous'], "Rate limit MUST NOT be classified as ambiguous")
        self.assertTrue(res['retryable'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 180)
        self.assertEqual(res['reason'], 'rate_limit')
        self.assertIn('rawError', res)

    async def test_code_88_and_185_rate_limit_fast_path(self):
        """Codes 88 and 185 MUST also trigger the rate limit fast path without timeline verification."""
        for code in (88, 185):
            self.session.used = False  # reset session dispatch gate for test
            err = Exception(f"Twitter error code {code}")
            setattr(err, 'code', code)
            setattr(err, 'retry_after_seconds', 75)
            self.mock_client.create_tweet = AsyncMock(side_effect=err)
            self.session.verify_timeline = AsyncMock()

            res = await self.session.publish("Tweet text", dispatch=lambda: True)

            self.assertEqual(self.session.verify_timeline.await_count, 0)
            self.assertTrue(res['rateLimit'])
            self.assertFalse(res['ambiguous'])
            self.assertEqual(res['accountFailure'], 'rate_limit')
            self.assertEqual(res['retryAfterSeconds'], 75)

    async def test_contrast_network_timeout_calls_verify_timeline(self):
        """Contrast: A network drop/timeout after dispatch MUST call verify_timeline to check if tweet landed."""
        import httpx
        err = httpx.ConnectTimeout("Connection to X timed out")
        self.mock_client.create_tweet = AsyncMock(side_effect=err)

        # When verify_timeline cannot find the tweet on timeline
        self.session.verify_timeline = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'verified': False,
            'found': False,
            'reason': 'publish_confirmation_missing'
        })

        res = await self.session.publish("Tweet text", dispatch=lambda: True)

        # Timeline verification MUST be invoked
        self.assertEqual(self.session.verify_timeline.await_count, 1, "verify_timeline MUST be called on network timeout")
        # And result is marked ambiguous
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['status'], 'ambiguous')
        self.assertFalse(res.get('rateLimit', False))


if __name__ == '__main__':
    unittest.main()
