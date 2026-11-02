#!/usr/bin/env python3
"""
Unit tests for Milestone M2:
1. create_tweet returning None / invalid validation triggers timeline verification.
2. If tweet landed on X: recovered with { published: True, url, tweetId }.
3. If tweet did not land on X: diagnoses failure (rate limit, auth, network/proxy) rather than false author unverified.
4. Explicit HTTP 429 rate limit propagation ({ published: False, rateLimit: True, retryAfterSeconds: N, accountFailure: 'rate_limit', reason: 'rate_limit' }).
5. Granular 8-class diagnostics ('banned', 'captcha', 'cookie_expired', 'auth_rejected', 'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown').
6. Network / proxy timeouts strictly return 'network_proxy_error' (never 'banned').
"""
import asyncio
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_compat import classify_x_account_failure
from direct_x_bridge import (
    DirectSession,
    extract_retry_after_seconds,
    is_rate_limit_exception,
    KNOWN_ACCOUNT_FAILURES,
)


class TestM2CreateTweetNoneAndTimelineVerification(unittest.IsolatedAsyncioTestCase):
    """Verify behavior when create_tweet returns None or author/id validation fails."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'alpha_user',
            'userId': '99887766',
            'use_cache': False
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'alpha_user',
            'userId': '99887766'
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_create_tweet_returns_none_but_lands_on_timeline(self):
        """When create_tweet returns None but the post is found on timeline, return published: True with URL and tweetId."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '1234567890123456',
            'tweetUrl': 'https://x.com/alpha_user/status/1234567890123456',
            'username': 'alpha_user',
            'userId': '99887766',
            'recoveredFromTimeline': True,
        })

        result = await self.session.publish("Hello from recovered tweet", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(result['published'])
        self.assertTrue(result['posted'])
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['tweetId'], '1234567890123456')
        self.assertEqual(result['url'], 'https://x.com/alpha_user/status/1234567890123456')
        self.assertTrue(result['recoveredFromTimeline'])

    async def test_create_tweet_returns_none_and_not_on_timeline_defaults_to_none_reason(self):
        """When create_tweet returns None and post is not on timeline, return reason 'create_tweet_returned_none'."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'verified': False,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': None,
        })

        result = await self.session.publish("Unconfirmed tweet text", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(result['published'])
        self.assertTrue(result['ambiguous'])
        self.assertEqual(result['reason'], 'create_tweet_returned_none')
        # Crucial: MUST NOT be misleading 'publish_author_or_id_unverified'
        self.assertNotEqual(result['reason'], 'publish_author_or_id_unverified')

    async def test_create_tweet_returns_none_and_timeline_encounters_rate_limit(self):
        """When create_tweet returns None and timeline check encounters 429 rate limit, propagate rate limit."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        err = Exception("HTTP 429 Too Many Requests")
        setattr(err, 'http_status', 429)
        setattr(err, 'retry_after_seconds', 120)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': 'HTTP 429 Too Many Requests',
            'fetchException': err,
        })

        result = await self.session.publish("Rate limited tweet check", dispatch=lambda: True)

        self.assertFalse(result['published'])
        self.assertTrue(result['rateLimit'])
        self.assertEqual(result['status'], 'rate_limit')
        self.assertEqual(result['accountFailure'], 'rate_limit')
        self.assertEqual(result['reason'], 'rate_limit')
        self.assertEqual(result['retryAfterSeconds'], 120)

    async def test_create_tweet_returns_none_and_timeline_encounters_proxy_error(self):
        """When create_tweet returns None and timeline check encounters SOCKS5 timeout, propagate network_proxy_error."""
        self.mock_client.create_tweet = AsyncMock(return_value=None)
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': 'socks5 connection timed out',
            'fetchException': Exception('socks5 connection timed out'),
        })

        result = await self.session.publish("Network proxy error tweet check", dispatch=lambda: True)

        self.assertFalse(result['published'])
        self.assertEqual(result['accountFailure'], 'network_proxy_error')
        self.assertEqual(result['reason'], 'network_proxy_error')
        self.assertTrue(result['retryable'])

    async def test_create_tweet_invalid_author_recovers_if_on_timeline(self):
        """When create_tweet returns an object with invalid author, but timeline confirms post, recover cleanly."""
        class MockInvalidTweet:
            id = 5566778899001122
            user = MagicMock()
            user.id = 99999999  # Mismatched user id
            user.screen_name = 'wrong_user'

        self.mock_client.create_tweet = AsyncMock(return_value=MockInvalidTweet())
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'published',
            'published': True,
            'posted': True,
            'ok': True,
            'found': True,
            'tweetId': '5566778899001122',
            'tweetUrl': 'https://x.com/alpha_user/status/5566778899001122',
            'username': 'alpha_user',
            'userId': '99887766',
            'recoveredFromTimeline': True,
        })

        result = await self.session.publish("Tweet with initially mismatched author", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertTrue(result['published'])
        self.assertEqual(result['tweetId'], '5566778899001122')
        self.assertEqual(result['url'], 'https://x.com/alpha_user/status/5566778899001122')

    async def test_create_tweet_invalid_author_unconfirmed_on_timeline(self):
        """When create_tweet returns invalid author and timeline does not have post, return author unverified."""
        class MockInvalidTweet:
            id = 5566778899001122
            user = MagicMock()
            user.id = 99999999  # Mismatched user id
            user.screen_name = 'wrong_user'

        self.mock_client.create_tweet = AsyncMock(return_value=MockInvalidTweet())
        self.session.verify_timeline_has_post = AsyncMock(return_value={
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'found': False,
            'fetchError': None,
        })

        result = await self.session.publish("Tweet with genuine author mismatch", dispatch=lambda: True)

        self.assertEqual(self.session.verify_timeline_has_post.await_count, 1)
        self.assertFalse(result['published'])
        self.assertTrue(result['ambiguous'])
        self.assertEqual(result['reason'], 'publish_author_or_id_unverified')


class TestM2ExplicitRateLimitPropagation(unittest.IsolatedAsyncioTestCase):
    """Verify explicit rate limit propagation under twikit, httpx, and error codes."""

    def setUp(self):
        self.mock_client = MagicMock()
        self.account = {
            'username': 'beta_user',
            'userId': '11223344',
            'use_cache': False
        }
        self.session = DirectSession(self.mock_client, self.account)
        self.session.verified = {
            'state': 'authenticated',
            'authenticated': True,
            'username': 'beta_user',
            'userId': '11223344'
        }
        self.session.identity = AsyncMock(return_value=self.session.verified)

    async def test_publish_httpx_429_propagates_rate_limit(self):
        """httpx.HTTPStatusError with 429 propagates rateLimit: True and retryAfterSeconds."""
        import httpx
        request = httpx.Request('POST', 'https://x.com/i/api/graphql/CreateTweet')
        response = httpx.Response(429, headers={'retry-after': '240'}, request=request)
        err = httpx.HTTPStatusError("Client error '429 Too Many Requests'", request=request, response=response)

        self.mock_client.create_tweet = AsyncMock(side_effect=err)
        self.session.verify_timeline_has_post = AsyncMock()

        result = await self.session.publish("Rate limited via httpx", dispatch=lambda: True)

        # Timeline verification must NOT be called on fast-path rate limit
        self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
        self.assertFalse(result['published'])
        self.assertTrue(result['rateLimit'])
        self.assertEqual(result['status'], 'rate_limit')
        self.assertEqual(result['accountFailure'], 'rate_limit')
        self.assertEqual(result['reason'], 'rate_limit')
        self.assertEqual(result['retryAfterSeconds'], 240)

    async def test_publish_code_88_and_185_rate_limits(self):
        """Twitter API error code 88 and 185 propagate rate limit cleanly."""
        for code in (88, 185):
            self.session.used = False
            err = Exception(f"Twitter error code {code}")
            setattr(err, 'code', code)
            setattr(err, 'retry_after_seconds', 300)

            self.mock_client.create_tweet = AsyncMock(side_effect=err)
            self.session.verify_timeline_has_post = AsyncMock()

            result = await self.session.publish(f"Rate limited with code {code}", dispatch=lambda: True)

            self.assertEqual(self.session.verify_timeline_has_post.await_count, 0)
            self.assertFalse(result['published'])
            self.assertTrue(result['rateLimit'])
            self.assertEqual(result['accountFailure'], 'rate_limit')
            self.assertEqual(result['retryAfterSeconds'], 300)

    def test_extract_retry_after_seconds_variations(self):
        """extract_retry_after_seconds handles numeric attributes, headers, and text regex."""
        # 1. retry_after_seconds attribute
        e1 = Exception("Rate limit")
        setattr(e1, 'retry_after_seconds', 75)
        self.assertEqual(extract_retry_after_seconds(e1), 75)

        # 2. retry_after attribute as string
        e2 = Exception("Rate limit")
        setattr(e2, 'retry_after', '150')
        self.assertEqual(extract_retry_after_seconds(e2), 150)

        # 3. headers dict with retry-after
        e3 = Exception("Rate limit")
        setattr(e3, 'headers', {'retry-after': '90'})
        self.assertEqual(extract_retry_after_seconds(e3), 90)

        # 4. response headers on httpx error
        import httpx
        req = httpx.Request('POST', 'https://x.com')
        resp = httpx.Response(429, headers={'retry-after': '180'}, request=req)
        e4 = httpx.HTTPStatusError("429", request=req, response=resp)
        self.assertEqual(extract_retry_after_seconds(e4), 180)

        # 5. Regex in message
        e5 = Exception("Rate limit exceeded: retry after 200 seconds")
        self.assertEqual(extract_retry_after_seconds(e5), 200)

        # 6. Default clamping (bounds: [60, 900])
        e6 = Exception("Too fast")
        setattr(e6, 'retry_after_seconds', 10)  # below 60 -> clamp to 60
        self.assertEqual(extract_retry_after_seconds(e6), 60)

        e7 = Exception("Too slow")
        setattr(e7, 'retry_after_seconds', 3600)  # above 900 -> clamp to 900
        self.assertEqual(extract_retry_after_seconds(e7), 900)


class TestM2Granular8ClassDiagnostics(unittest.TestCase):
    """Verify classify_x_account_failure across all 8 canonical classes and network safety."""

    def test_all_8_categories_represented_in_known_failures(self):
        canonical = {
            'banned', 'captcha', 'cookie_expired', 'auth_rejected',
            'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown'
        }
        for category in canonical:
            self.assertIn(category, KNOWN_ACCOUNT_FAILURES)

    def test_class_banned(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 63}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 141}]), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'reason': 'Suspended'}), 'banned')
        self.assertEqual(classify_x_account_failure(text='Account has been suspended'), 'banned')
        self.assertEqual(classify_x_account_failure(text='User is suspended'), 'banned')

    def test_class_captcha(self):
        for code in (326, 353, 399, 241):
            self.assertEqual(classify_x_account_failure(errors=[{'code': code}]), 'captcha')
        self.assertEqual(classify_x_account_failure(raw_json={'bounce_location': 'https://twitter.com/account/access'}), 'captcha')
        self.assertEqual(classify_x_account_failure(text='challenge_required: solve arkose captcha'), 'captcha')

    def test_class_cookie_expired(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'cookie_expired')
        self.assertEqual(classify_x_account_failure(text='session invalidated: token is expired'), 'cookie_expired')

    def test_class_auth_rejected(self):
        for code in (32, 135, 215, 99, 231):
            self.assertEqual(classify_x_account_failure(errors=[{'code': code}]), 'auth_rejected')
        self.assertEqual(classify_x_account_failure(text='bad authentication data: could not authenticate you'), 'auth_rejected')

    def test_class_rate_limit(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 88}]), 'rate_limit')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 185}]), 'rate_limit')
        self.assertEqual(classify_x_account_failure(http_status=429), 'rate_limit')
        self.assertEqual(classify_x_account_failure(text='User is over daily status update limit'), 'rate_limit')

    def test_class_network_proxy_error(self):
        for phrase in (
            'proxy error: socks5 handshake failed',
            'connection refused by 127.0.0.1:18801',
            'httpx.ConnectTimeout: connection timed out',
            'ReadTimeout: stream timed out',
            'network unreachable',
            'name resolution failure: getaddrinfo failed',
            'econnrefused',
            'etimedout'
        ):
            self.assertEqual(classify_x_account_failure(text=phrase), 'network_proxy_error')

    def test_class_ambiguous(self):
        self.assertEqual(classify_x_account_failure(text='publish_confirmation_missing'), 'ambiguous')
        self.assertEqual(classify_x_account_failure(text='eventual consistency delay'), 'ambiguous')
        self.assertEqual(classify_x_account_failure(text='dispatch_already_attempted'), 'ambiguous')

    def test_class_unknown(self):
        self.assertEqual(classify_x_account_failure(text='unknown internal system error'), 'unknown')
        self.assertEqual(classify_x_account_failure(text='unspecified failure detected'), 'unknown')

    def test_network_proxy_timeouts_strictly_never_banned(self):
        """CRITICAL: SOCKS5 proxy / network timeouts mentioning suspended endpoints must NEVER return 'banned'."""
        dangerous_strings = [
            "SOCKS5 proxy connection timed out while checking suspended user account",
            "Proxy error: connection refused to https://x.com/account/suspended",
            "Network timeout: failed to connect to account suspended verification endpoint",
            "httpx.ConnectTimeout: User is suspended endpoint unreachable",
            "Connection reset by peer while fetching account status for suspended test",
        ]
        for s in dangerous_strings:
            result = classify_x_account_failure(text=s)
            self.assertEqual(result, 'network_proxy_error', f"Expected 'network_proxy_error' but got {result} for '{s}'")
            self.assertNotEqual(result, 'banned', f"CRITICAL: '{s}' falsely classified as 'banned'!")


if __name__ == '__main__':
    unittest.main()
