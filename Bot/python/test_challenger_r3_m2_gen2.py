#!/usr/bin/env python3
"""
Adversarial Challenger Verification Suite — Generation 2 (challenger_r3_m2_2_gen2)
Milestone M2: Python Direct X Bridge & Diagnostics

Empirically verifies:
1. Timeline recovery when create_tweet returns None, malformed objects, or unverified author.
2. Differentiation between create_tweet_returned_none vs publish_author_or_id_unverified.
3. Fast-path and timeline rate limit propagation across httpx, twikit, status codes, and error codes.
4. Header parsing, case insensitivity, regex fallback, and strict [60, 900] clamping.
5. Absolute precedence of network/proxy/timeout errors over banned and ambiguous patterns.
6. Clean coverage of all 8 canonical diagnostic categories.
"""
import asyncio
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_compat import classify_x_account_failure
from direct_x_bridge import (
    DirectSession,
    extract_retry_after_seconds,
    is_rate_limit_exception,
    KNOWN_ACCOUNT_FAILURES,
    uncertain,
    unsent,
)


class TestAdversarialTimelineRecovery(unittest.IsolatedAsyncioTestCase):
    """Stress test timeline recovery when create_tweet returns None, empty or malformed objects."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.mock_client._last_create_tweet_response = None
        self.mock_client._last_create_tweet_error = None
        self.account = {
            'username': 'alpha_test',
            'userId': '123456789',
            'use_cache': False,
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'alpha_test',
            'userId': '123456789',
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_create_tweet_none_timeline_found_recovers_verified_url_and_id(self):
        """When create_tweet returns None, verify_timeline_has_post recovers published tweet."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '9988776655443322',
            'tweetUrl': 'https://x.com/alpha_test/status/9988776655443322',
            'username': 'alpha_test',
            'userId': '123456789',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Hello recovered world", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertTrue(res['ok'])
        self.assertTrue(res['recoveredFromTimeline'])
        self.assertEqual(res['tweetId'], '9988776655443322')
        self.assertEqual(res['url'], 'https://x.com/alpha_test/status/9988776655443322')

    async def test_create_tweet_none_timeline_not_found_returns_create_tweet_returned_none(self):
        """When create_tweet returns None and not found, reason must be create_tweet_returned_none."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': None,
        })

        res = await self.session.publish("Unconfirmed text", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'create_tweet_returned_none')
        self.assertNotEqual(res['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_none_timeline_hits_429_returns_rate_limit(self):
        """When create_tweet returns None but timeline verification hits 429 rate limit."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        err = Exception("Timeline 429 Too Many Requests")
        setattr(err, 'http_status', 429)
        setattr(err, 'retry_after_seconds', 250)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': 'Timeline 429 Too Many Requests',
            'fetchException': err,
        })

        res = await self.session.publish("Timeline 429 test", dispatch=lambda: True)

        self.assertFalse(res['published'])
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 250)
        self.assertEqual(res['reason'], 'rate_limit')

    async def test_create_tweet_none_timeline_hits_proxy_timeout(self):
        """When create_tweet returns None and timeline verification encounters proxy timeout."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        err = Exception("socks5 proxy handshake timed out")
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': 'socks5 proxy handshake timed out',
            'fetchException': err,
        })

        res = await self.session.publish("Timeline proxy error test", dispatch=lambda: True)

        self.assertFalse(res['published'])
        self.assertEqual(res['accountFailure'], 'network_proxy_error')
        self.assertEqual(res['reason'], 'network_proxy_error')
        self.assertTrue(res['retryable'])
        self.assertFalse(res['ambiguous'])

    async def test_create_tweet_author_mismatch_timeline_found_recovers(self):
        """Mismatched author object from create_tweet recovers if timeline confirms post."""
        mismatched_tweet = SimpleNamespace(
            id='1122334455',
            user=SimpleNamespace(id='999999999', screen_name='impostor_user')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=mismatched_tweet)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '1122334455',
            'tweetUrl': 'https://x.com/alpha_test/status/1122334455',
            'username': 'alpha_test',
            'userId': '123456789',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Mismatched author recovered", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertTrue(res['recoveredFromTimeline'])
        self.assertEqual(res['tweetId'], '1122334455')

    async def test_create_tweet_author_mismatch_timeline_not_found_returns_author_unverified(self):
        """When tweet object exists with genuine author mismatch and not on timeline."""
        mismatched_tweet = SimpleNamespace(
            id='1122334455',
            user=SimpleNamespace(id='999999999', screen_name='impostor_user')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=mismatched_tweet)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': None,
        })

        res = await self.session.publish("Genuinely unverified author", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_author_mismatch_timeline_trace_id_containing_429_stays_ambiguous(self):
        """Numeric 429 embedded in a trace ID is not an HTTP 429 status."""
        mismatched_tweet = SimpleNamespace(
            id='1122334455',
            user=SimpleNamespace(id='999999999', screen_name='impostor_user')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=mismatched_tweet)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': 'unrelated_trace_id_123429987654',
            'fetchException': None,
        })

        res = await self.session.publish("Author mismatch with embedded 429 trace", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_author_mismatch_with_mock_client_error_preserves_ambiguous(self):
        """Author mismatch must not be misclassified as rate_limit if client mock has _last_create_tweet_error."""
        mismatched_tweet = SimpleNamespace(
            id='1122334455',
            user=SimpleNamespace(id='999999999', screen_name='impostor_user')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=mismatched_tweet)
        # Injected mock attribute with digits 429 to prove isolation against string/repr false-positives
        self.mock_client._last_create_tweet_error = MagicMock(name='mock_429_client_error')
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': None,
        })

        res = await self.session.publish("Author mismatch with mock error", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'publish_author_or_id_unverified')


class TestAdversarialRateLimitPropagation(unittest.IsolatedAsyncioTestCase):
    """Stress test rate limit exception handling and parameter parsing."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'beta_test',
            'userId': '987654321',
            'use_cache': False,
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'beta_test',
            'userId': '987654321',
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_httpx_429_fast_path_never_invokes_timeline(self):
        """httpx 429 error during create_tweet must fast-path and NOT query timeline."""
        import httpx
        req = httpx.Request('POST', 'https://x.com/i/api/graphql/CreateTweet')
        resp = httpx.Response(429, headers={'retry-after': '180'}, request=req)
        err = httpx.HTTPStatusError("Client error '429 Too Many Requests'", request=req, response=resp)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("Fast path 429", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertFalse(res['published'])
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['reason'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 180)

    async def test_twikit_rate_limit_attribute(self):
        """twikit error with rate limit reset timestamp."""
        err = Exception("Rate limit")
        setattr(err, 'account_failure', 'rate_limit')
        setattr(err, 'rate_limit_reset', time.time() + 350)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("Twikit reset test", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertTrue(345 <= res['retryAfterSeconds'] <= 355)

    def test_extract_retry_after_clamping_and_case_insensitivity(self):
        """extract_retry_after_seconds clamps to [60, 900] and supports case-insensitive headers."""
        # 1. Under minimum clamp (15s -> 60s)
        e1 = Exception("low")
        setattr(e1, 'retry_after_seconds', 15)
        self.assertEqual(extract_retry_after_seconds(e1), 60)

        # 2. Over maximum clamp (3600s -> 900s)
        e2 = Exception("high")
        setattr(e2, 'retry_after_seconds', 3600)
        self.assertEqual(extract_retry_after_seconds(e2), 900)

        # 3. Capitalized Retry-After
        e3 = Exception("cap")
        setattr(e3, 'headers', {'Retry-After': '240'})
        self.assertEqual(extract_retry_after_seconds(e3), 240)

        # 4. Capitalized X-Rate-Limit-Reset
        now = time.time()
        e4 = Exception("cap reset")
        setattr(e4, 'headers', {'X-Rate-Limit-Reset': str(int(now + 500))})
        diff = extract_retry_after_seconds(e4)
        self.assertTrue(495 <= diff <= 505)

        # 5. Regex in exception message
        e5 = Exception("Rate limit exceeded; please retry after 400 seconds")
        self.assertEqual(extract_retry_after_seconds(e5), 400)


class TestAdversarialDiagnosticPrecedenceAnd8Classes(unittest.TestCase):
    """Stress test precedence: proxy errors must NEVER be classified as banned."""

    def test_all_8_classes_supported(self):
        classes = {
            'banned', 'captcha', 'cookie_expired', 'auth_rejected',
            'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown'
        }
        for c in classes:
            self.assertIn(c, KNOWN_ACCOUNT_FAILURES)

    def test_proxy_timeout_strictly_precedes_banned(self):
        """Hostile strings containing both proxy timeout and banned keywords MUST be network_proxy_error."""
        hostile_inputs = [
            "socks5 connection timed out while inspecting user suspended status",
            "Proxy error: connection refused to endpoint https://x.com/account/suspended",
            "httpx.ConnectTimeout: account suspended verification timed out",
            "ETIMEDOUT: connect to proxy port 18802 failed for suspended check",
            "ECONNREFUSED 127.0.0.1:18803 while checking if user is suspended",
            "temporary failure in name resolution for proxy host during suspended verify",
            "Read timeout while querying account suspended state through SOCKS5 proxy",
            "broken pipe on proxy socket when fetching suspended user profile",
            "socket timeout: failed to connect to proxy endpoint for suspended account",
        ]
        for text in hostile_inputs:
            diag = classify_x_account_failure(text=text)
            self.assertEqual(diag, 'network_proxy_error', f"Failed for '{text}': got {diag}")
            self.assertNotEqual(diag, 'banned', f"Banned false-positive on '{text}'!")

    def test_proxy_timeout_strictly_precedes_ambiguous(self):
        """Hostile strings containing both proxy timeout and ambiguous markers MUST be network_proxy_error."""
        hostile_inputs = [
            "socks5 handshake timeout during publish_confirmation_missing",
            "proxy connect timeout on eventual consistency timeline check",
            "connection refused: dispatch_already_attempted",
        ]
        for text in hostile_inputs:
            diag = classify_x_account_failure(text=text)
            self.assertEqual(diag, 'network_proxy_error', f"Failed for '{text}': got {diag}")
            self.assertNotEqual(diag, 'ambiguous', f"Ambiguous false-positive on '{text}'!")

    def test_canonical_classifications(self):
        # Banned
        self.assertEqual(classify_x_account_failure(text="This account has been suspended"), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')

        # Captcha
        self.assertEqual(classify_x_account_failure(errors=[{'code': 326}]), 'captcha')
        self.assertEqual(classify_x_account_failure(text="Arkose challenge required"), 'captcha')

        # Cookie expired
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'cookie_expired')

        # Auth rejected
        self.assertEqual(classify_x_account_failure(errors=[{'code': 32}]), 'auth_rejected')

        # Rate limit
        self.assertEqual(classify_x_account_failure(http_status=429), 'rate_limit')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 88}]), 'rate_limit')

        # Network proxy error
        self.assertEqual(classify_x_account_failure(text="socks5 connection reset by peer"), 'network_proxy_error')

        # Ambiguous
        self.assertEqual(classify_x_account_failure(text="publish_confirmation_missing"), 'ambiguous')

        # Unknown
        self.assertEqual(classify_x_account_failure(text="unspecified server error"), 'unknown')


if __name__ == '__main__':
    unittest.main()
