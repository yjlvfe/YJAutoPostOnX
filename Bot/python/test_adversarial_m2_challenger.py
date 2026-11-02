#!/usr/bin/env python3
"""
Adversarial Challenger Test Suite for Milestone M2:
Python Direct X Bridge & Diagnostics.

Targeting:
1. create_tweet returning None or malformed tweet objects, asserting timeline verification works as intended.
2. HTTP 429 status codes, rate limit reset parsing, and backoff clamps.
3. Ambiguous vs proxy timeout vs banned classification precedence across all 8 canonical classes.
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


class TestCreateTweetMalformedAndTimelineVerification(unittest.IsolatedAsyncioTestCase):
    """Stress test create_tweet returning None, empty objects, and malformed structures."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'alpha_tester',
            'userId': '12345678',
            'use_cache': False,
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'alpha_tester',
            'userId': '12345678',
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_create_tweet_returns_none_and_timeline_recovers(self):
        """None from create_tweet with successful timeline match must recover cleanly."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '987654321012345',
            'tweetUrl': 'https://x.com/alpha_tester/status/987654321012345',
            'username': 'alpha_tester',
            'userId': '12345678',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Valid tweet recovering from None", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertTrue(res['ok'])
        self.assertTrue(res['recoveredFromTimeline'])
        self.assertEqual(res['tweetId'], '987654321012345')
        self.assertEqual(res['url'], 'https://x.com/alpha_tester/status/987654321012345')

    async def test_create_tweet_returns_none_and_timeline_not_found_is_not_author_unverified(self):
        """None from create_tweet without timeline confirmation must report create_tweet_returned_none."""
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

        res = await self.session.publish("Unconfirmed tweet text", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'create_tweet_returned_none')
        self.assertNotEqual(res['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_returns_empty_dict(self):
        """Empty dict as tweet object is malformed: triggers timeline check."""
        self.mock_client.create_tweet = AsyncMock(return_value={})
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '111222333444',
            'tweetUrl': 'https://x.com/alpha_tester/status/111222333444',
            'username': 'alpha_tester',
            'userId': '12345678',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Empty dict tweet test", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertEqual(res['tweetId'], '111222333444')

    async def test_create_tweet_malformed_missing_user(self):
        """Tweet with valid numeric id but user=None must verify timeline."""
        malformed = SimpleNamespace(id=1234567890123456, user=None)
        self.mock_client.create_tweet = AsyncMock(return_value=malformed)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '1234567890123456',
            'tweetUrl': 'https://x.com/alpha_tester/status/1234567890123456',
            'username': 'alpha_tester',
            'userId': '12345678',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Missing user tweet", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])

    async def test_create_tweet_malformed_non_numeric_id(self):
        """Tweet with non-numeric id ('alpha_id_str') must fail validation and check timeline."""
        malformed = SimpleNamespace(
            id='alpha_id_str',
            user=SimpleNamespace(id='12345678', screen_name='alpha_tester')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=malformed)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '8888888888',
            'tweetUrl': 'https://x.com/alpha_tester/status/8888888888',
            'username': 'alpha_tester',
            'userId': '12345678',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Non-numeric id test", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertEqual(res['tweetId'], '8888888888')

    async def test_create_tweet_malformed_mismatched_author_not_on_timeline(self):
        """Mismatched author id without timeline presence must return publish_author_or_id_unverified."""
        mismatched = SimpleNamespace(
            id=7777777777,
            user=SimpleNamespace(id='99999999', screen_name='other_user')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=mismatched)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': None,
        })

        res = await self.session.publish("Author mismatch unconfirmed", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_author_normalization_with_at_and_caps(self):
        """Screen name with leading @ and uppercase must normalize cleanly on immediate check when id is str."""
        valid_tweet = SimpleNamespace(
            id='555666777888',
            user=SimpleNamespace(id='12345678', screen_name='@ALPHA_TESTER')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=valid_tweet)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("Normalized author test", dispatch=lambda: True)

        # Immediate validation must succeed without hitting timeline check
        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertTrue(res['published'])
        self.assertEqual(res['tweetId'], '555666777888')
        self.assertEqual(res['url'], 'https://x.com/alpha_tester/status/555666777888')

    async def test_create_tweet_integer_id_triggers_timeline_recovery(self):
        """When create_tweet returns int id, numeric_id fails; triggers timeline check and recovers."""
        int_id_tweet = SimpleNamespace(
            id=555666777888,  # int instead of str
            user=SimpleNamespace(id='12345678', screen_name='alpha_tester')
        )
        self.mock_client.create_tweet = AsyncMock(return_value=int_id_tweet)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '555666777888',
            'tweetUrl': 'https://x.com/alpha_tester/status/555666777888',
            'username': 'alpha_tester',
            'userId': '12345678',
            'recoveredFromTimeline': True,
        })

        res = await self.session.publish("Int id triggers timeline recovery", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(res['published'])
        self.assertTrue(res['recoveredFromTimeline'])
        self.assertEqual(res['tweetId'], '555666777888')

    async def test_create_tweet_none_and_timeline_raises_exception_graceful(self):
        """When create_tweet returns None and verify_timeline_has_post raises exception, handle gracefully."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(side_effect=RuntimeError("GQL network glitch"))

        res = await self.session.publish("Timeline exception test", dispatch=lambda: True)

        self.assertFalse(res['published'])
        self.assertTrue(res['ambiguous'])
        self.assertEqual(res['reason'], 'create_tweet_returned_none')
        self.assertIn('GQL network glitch', res.get('fetchError', ''))


class TestHttp429AndRateLimitClamps(unittest.IsolatedAsyncioTestCase):
    """Stress test HTTP 429 status codes, rate limit reset parsing, and bounds clamping."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'gamma_tester',
            'userId': '33445566',
            'use_cache': False,
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'gamma_tester',
            'userId': '33445566',
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_httpx_429_fast_path_skips_timeline(self):
        """httpx.HTTPStatusError 429 must skip timeline verification and return rate limit schema."""
        import httpx
        req = httpx.Request('POST', 'https://x.com/i/api/graphql/CreateTweet')
        resp = httpx.Response(429, headers={'retry-after': '300'}, request=req)
        err = httpx.HTTPStatusError("Client error '429'", request=req, response=resp)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("httpx 429 rate limit", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertFalse(res['published'])
        self.assertTrue(res['rateLimit'])
        self.assertFalse(res['ambiguous'])
        self.assertTrue(res['retryable'])
        self.assertEqual(res['status'], 'rate_limit')
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['reason'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 300)

    async def test_twikit_too_many_requests_fast_path(self):
        """twikit.errors.TooManyRequests skips timeline verification."""
        import twikit.errors
        err = twikit.errors.TooManyRequests("Rate limit reached")
        setattr(err, 'retry_after_seconds', 450)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("twikit TooManyRequests", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 450)

    async def test_custom_exception_status_code_429(self):
        """Custom exception with status_code=429 skips timeline verification."""
        err = Exception("Custom 429 error")
        setattr(err, 'status_code', 429)
        setattr(err, 'retry_after_seconds', 120)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        res = await self.session.publish("custom 429", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 120)

    async def test_timeline_encountering_rate_limit(self):
        """When timeline check itself hits 429, propagate rate limit cleanly."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        err = Exception("Timeline 429 rate limit")
        setattr(err, 'http_status', 429)
        setattr(err, 'retry_after_seconds', 500)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': 'Timeline 429 rate limit',
            'fetchException': err,
        })

        res = await self.session.publish("Timeline rate limit check", dispatch=lambda: True)

        self.assertFalse(res['published'])
        self.assertTrue(res['rateLimit'])
        self.assertEqual(res['accountFailure'], 'rate_limit')
        self.assertEqual(res['retryAfterSeconds'], 500)

    def test_extract_retry_after_seconds_clamps(self):
        """extract_retry_after_seconds must strictly clamp between [60, 900]."""
        # Lower bound clamp (< 60 -> 60)
        e_low = Exception("low")
        setattr(e_low, 'retry_after_seconds', 15)
        self.assertEqual(extract_retry_after_seconds(e_low), 60)

        # Upper bound clamp (> 900 -> 900)
        e_high = Exception("high")
        setattr(e_high, 'retry_after_seconds', 7200)
        self.assertEqual(extract_retry_after_seconds(e_high), 900)

        # Exact boundary lower
        e_60 = Exception("exact 60")
        setattr(e_60, 'retry_after_seconds', 60)
        self.assertEqual(extract_retry_after_seconds(e_60), 60)

        # Exact boundary upper
        e_900 = Exception("exact 900")
        setattr(e_900, 'retry_after_seconds', 900)
        self.assertEqual(extract_retry_after_seconds(e_900), 900)

        # None exception with out-of-bounds default
        self.assertEqual(extract_retry_after_seconds(None, default=0), 60)
        self.assertEqual(extract_retry_after_seconds(None, default=5000), 900)
        self.assertEqual(extract_retry_after_seconds(None, default=180), 180)

    def test_extract_retry_after_epoch_reset(self):
        """extract_retry_after_seconds handles future and past epoch resets."""
        now = time.time()

        # Future reset ~300s
        e_future = Exception("future reset")
        setattr(e_future, 'rate_limit_reset', now + 300)
        diff = extract_retry_after_seconds(e_future)
        self.assertTrue(295 <= diff <= 305, f"Expected ~300, got {diff}")

        # Past reset (should clamp to 60)
        e_past = Exception("past reset")
        setattr(e_past, 'rate_limit_reset', now - 120)
        self.assertEqual(extract_retry_after_seconds(e_past), 60)

        # Headers with x-rate-limit-reset
        e_hdr = Exception("hdr reset")
        setattr(e_hdr, 'headers', {'x-rate-limit-reset': str(int(now + 400))})
        diff_hdr = extract_retry_after_seconds(e_hdr)
        self.assertTrue(395 <= diff_hdr <= 405, f"Expected ~400, got {diff_hdr}")

    def test_is_rate_limit_exception_broad_matching(self):
        """is_rate_limit_exception must catch all standard rate limit signatures."""
        self.assertFalse(is_rate_limit_exception(None))

        e1 = Exception("rate limit exceeded")
        self.assertTrue(is_rate_limit_exception(e1))

        e2 = Exception("user is over daily status update limit")
        self.assertTrue(is_rate_limit_exception(e2))

        e3 = Exception("429 Too Many Requests")
        self.assertTrue(is_rate_limit_exception(e3))

        e4 = Exception("unknown")
        setattr(e4, 'code', 88)
        self.assertTrue(is_rate_limit_exception(e4))

        e5 = Exception("unknown")
        setattr(e5, 'error_code', 185)
        self.assertTrue(is_rate_limit_exception(e5))

        e6 = Exception("network timeout")
        self.assertFalse(is_rate_limit_exception(e6))


class TestDiagnosticPrecedenceAnd8Classes(unittest.TestCase):
    """Stress test precedence: ambiguous vs proxy timeout vs banned across all 8 classes."""

    def test_known_account_failures_includes_all_8_canonical(self):
        canonical_8 = {
            'banned', 'captcha', 'cookie_expired', 'auth_rejected',
            'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown'
        }
        for item in canonical_8:
            self.assertIn(item, KNOWN_ACCOUNT_FAILURES, f"Missing canonical class '{item}'")

    def test_proxy_timeout_precedes_banned_pattern(self):
        """CRITICAL: Messages with proxy/timeout AND suspended words must strictly return network_proxy_error."""
        scenarios = [
            "SOCKS5 proxy connection timed out while checking suspended user account",
            "Proxy error: connection refused to https://x.com/account/suspended",
            "Network timeout: failed to connect to account suspended verification endpoint",
            "httpx.ConnectTimeout: User is suspended endpoint unreachable",
            "Connection reset by peer while fetching account status for suspended test",
            "ETIMEDOUT: connect to proxy port 18801 failed for suspended check",
            "Name resolution failure: getaddrinfo failed for suspended verification",
            "Read timeout while communicating with socks5 proxy for user is suspended",
        ]
        for s in scenarios:
            res = classify_x_account_failure(text=s)
            self.assertEqual(res, 'network_proxy_error', f"Expected network_proxy_error but got {res} for: {s}")
            self.assertNotEqual(res, 'banned', f"Banned false-positive detected for: {s}")

    def test_proxy_timeout_precedes_ambiguous_keywords(self):
        """Messages with proxy/timeout AND ambiguous words must strictly return network_proxy_error."""
        scenarios = [
            "socks5 connection timed out: publish_confirmation_missing",
            "proxy error: eventual consistency check failed",
            "Connection reset by peer during dispatch_already_attempted",
            "read timeout on ambiguous post status verification",
        ]
        for s in scenarios:
            res = classify_x_account_failure(text=s)
            self.assertEqual(res, 'network_proxy_error', f"Expected network_proxy_error but got {res} for: {s}")
            self.assertNotEqual(res, 'ambiguous', f"Ambiguous false-positive detected for: {s}")

    def test_pure_banned_classification(self):
        """Pure banned indications without network errors must return banned."""
        self.assertEqual(classify_x_account_failure(text="Account has been suspended"), 'banned')
        self.assertEqual(classify_x_account_failure(text="User is suspended"), 'banned')
        self.assertEqual(classify_x_account_failure(text="account suspended"), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'reason': 'Suspended'}), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 63}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 141}]), 'banned')

    def test_pure_ambiguous_classification(self):
        """Ambiguous markers without proxy or banned markers must return ambiguous."""
        self.assertEqual(classify_x_account_failure(text="publish_confirmation_missing"), 'ambiguous')
        self.assertEqual(classify_x_account_failure(text="eventual consistency delay"), 'ambiguous')
        self.assertEqual(classify_x_account_failure(text="dispatch_already_attempted"), 'ambiguous')
        self.assertEqual(classify_x_account_failure(text="unconfirmed post status"), 'ambiguous')

    def test_pure_captcha_classification(self):
        """Arkose / challenge / bounce must return captcha."""
        self.assertEqual(classify_x_account_failure(errors=[{'code': 326}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 353}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 399}]), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 241}]), 'captcha')
        self.assertEqual(classify_x_account_failure(raw_json={'bounce_location': 'https://x.com/challenge'}), 'captcha')
        self.assertEqual(classify_x_account_failure(text="Solve arkose funcaptcha challenge"), 'captcha')

    def test_pure_cookie_expired_classification(self):
        """Code 89 or expired token must return cookie_expired."""
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'cookie_expired')
        self.assertEqual(classify_x_account_failure(text="session invalidated: token is expired"), 'cookie_expired')
        self.assertEqual(classify_x_account_failure(text="invalid or expired token"), 'cookie_expired')

    def test_pure_auth_rejected_classification(self):
        """Auth codes and invalid credentials must return auth_rejected."""
        for c in (32, 135, 215, 99, 231):
            self.assertEqual(classify_x_account_failure(errors=[{'code': c}]), 'auth_rejected')
        self.assertEqual(classify_x_account_failure(text="bad authentication data: could not authenticate you"), 'auth_rejected')

    def test_pure_unknown_and_none(self):
        """Unspecified errors return unknown; unrelated text returns None."""
        self.assertEqual(classify_x_account_failure(text="unknown error occurred"), 'unknown')
        self.assertEqual(classify_x_account_failure(text="unspecified failure"), 'unknown')
        self.assertIsNone(classify_x_account_failure(text="normal logging text with no errors"))


if __name__ == '__main__':
    unittest.main()
