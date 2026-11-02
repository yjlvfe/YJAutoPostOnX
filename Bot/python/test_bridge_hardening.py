#!/usr/bin/env python3
"""
Hardening and Adversarial Edge-Case Test Suite for Direct X Bridge (Milestone M3).
Covers 6 edge cases identified during architectural analysis:
1. SOCKS5 proxy regex boundary tampering (scheme modifiers, port boundaries, remote IPs, types).
2. Cookie security (1MB limit, non-X domains, CRLF injection, conflicting values, symlinks, mandatory auth).
3. Timeline tweet age boundary (>1800s rejected, <=1800s accepted, clock skew, malformed timestamps).
4. Negative author casing, Unicode homoglyphs, and impostor rejection in timeline verification.
5. Twitter API non-account error codes (code 187 duplicate tweet, 186, 385, 34) return None.
6. IPC framing, overlong line bounds, and OnlySocksTransport destination / CDN header stripping.
"""

import asyncio
import datetime
import io
import json
import os
import stat
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

# Ensure Python bridge modules can be resolved directly
sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_bridge import (
    validate_proxy,
    parse_cookies,
    read_cookies,
    is_recent_tweet,
    username,
    numeric_id,
    normalize_text_for_comparison,
    DirectSession,
    new_client,
    read_command,
)
from direct_x_compat import classify_x_account_failure


class TestProxyValidationHardening(unittest.TestCase):
    """Edge Case 1: SOCKS5 proxy regex boundary tampering tests."""

    def test_valid_proxies_loopback_and_localhost(self):
        """Valid proxy strings on ports 18801-18805 must return identical string."""
        for port in range(18801, 18806):
            p1 = f"socks5h://127.0.0.1:{port}"
            p2 = f"socks5h://localhost:{port}"
            self.assertEqual(validate_proxy(p1), p1)
            self.assertEqual(validate_proxy(p2), p2)

    def test_reject_scheme_tampering(self):
        """Missing 'h' (socks5://) or wrong schemes must raise ValueError('proxy_required')."""
        invalid_schemes = [
            "socks5://127.0.0.1:18801",
            "http://127.0.0.1:18801",
            "https://127.0.0.1:18801",
            "socks4://127.0.0.1:18801",
            "socks5h:/127.0.0.1:18801",
            "//127.0.0.1:18801",
        ]
        for proxy in invalid_schemes:
            with self.assertRaises(ValueError, msg=f"Should reject {proxy}") as ctx:
                validate_proxy(proxy)
            self.assertEqual(str(ctx.exception), "proxy_required")

    def test_reject_port_boundary_tampering(self):
        """Ports below 18801 (e.g. 18800) or above 18805 (e.g. 18806) must be rejected."""
        invalid_ports = [
            "socks5h://127.0.0.1:18800",
            "socks5h://127.0.0.1:18806",
            "socks5h://127.0.0.1:1880",
            "socks5h://127.0.0.1:188010",
            "socks5h://localhost:18800",
            "socks5h://localhost:18806",
            "socks5h://127.0.0.1:8080",
            "socks5h://127.0.0.1:1080",
        ]
        for proxy in invalid_ports:
            with self.assertRaises(ValueError, msg=f"Should reject {proxy}") as ctx:
                validate_proxy(proxy)
            self.assertEqual(str(ctx.exception), "proxy_required")

    def test_reject_remote_and_external_ips(self):
        """Remote or external IPs must be rejected fail-closed to prevent host IP exposure."""
        remote_proxies = [
            "socks5h://192.168.1.1:18801",
            "socks5h://10.0.0.1:18801",
            "socks5h://172.16.0.1:18801",
            "socks5h://64.112.42.39:18801",
            "socks5h://8.8.8.8:18801",
            "socks5h://127.0.0.2:18801",
            "socks5h://0.0.0.0:18801",
        ]
        for proxy in remote_proxies:
            with self.assertRaises(ValueError, msg=f"Should reject {proxy}") as ctx:
                validate_proxy(proxy)
            self.assertEqual(str(ctx.exception), "proxy_required")

    def test_reject_non_string_types(self):
        """Non-string types must raise ValueError('proxy_required')."""
        for val in [None, 18801, ["socks5h://127.0.0.1:18801"], {}, True]:
            with self.assertRaises(ValueError):
                validate_proxy(val)


class TestCookieSecurityHardening(unittest.TestCase):
    """Edge Case 2: Cookie security, symlink rejection, and validation."""

    def test_reject_cookie_content_exceeding_1mb(self):
        """Cookie content > 1,048,576 bytes must raise ValueError('cookie_size')."""
        oversized = "a" * (1_048_576 + 1)
        with self.assertRaises(ValueError) as ctx:
            parse_cookies(oversized)
        self.assertEqual(str(ctx.exception), "cookie_size")

    def test_reject_non_x_domains(self):
        """Cookies for non-X domains (e.g. attacker.com, google.com) must be rejected."""
        json_data = json.dumps([
            {"name": "auth_token", "value": "valid_auth", "domain": ".attacker.com"},
            {"name": "ct0", "value": "valid_ct0", "domain": ".x.com"}
        ])
        with self.assertRaises(ValueError) as ctx:
            parse_cookies(json_data)
        self.assertEqual(str(ctx.exception), "cookie_domain")

    def test_reject_crlf_injection_in_cookie_value(self):
        """Values containing CR or LF must raise ValueError('cookie_invalid')."""
        payloads = [
            json.dumps({"auth_token": "token\r\ninjected: true", "ct0": "secret"}),
            json.dumps({"auth_token": "token\ninjected: true", "ct0": "secret"}),
            json.dumps({"auth_token": "token\rinjected: true", "ct0": "secret"}),
        ]
        for p in payloads:
            with self.assertRaises(ValueError) as ctx:
                parse_cookies(p)
            self.assertEqual(str(ctx.exception), "cookie_invalid")

    def test_reject_conflicting_cookie_values(self):
        """Conflicting values for the same cookie name must raise ValueError('cookie_conflict')."""
        json_data = json.dumps([
            {"name": "auth_token", "value": "val1", "domain": ".x.com"},
            {"name": "auth_token", "value": "val2", "domain": ".x.com"},
            {"name": "ct0", "value": "ct0_val", "domain": ".x.com"}
        ])
        with self.assertRaises(ValueError) as ctx:
            parse_cookies(json_data)
        self.assertEqual(str(ctx.exception), "cookie_conflict")

    def test_require_auth_token_and_ct0(self):
        """Missing either auth_token or ct0 must raise ValueError('cookie_auth_required')."""
        missing_ct0 = json.dumps({"auth_token": "secret_auth"})
        with self.assertRaises(ValueError) as ctx:
            parse_cookies(missing_ct0)
        self.assertEqual(str(ctx.exception), "cookie_auth_required")

        missing_auth = json.dumps({"ct0": "secret_ct0"})
        with self.assertRaises(ValueError) as ctx:
            parse_cookies(missing_auth)
        self.assertEqual(str(ctx.exception), "cookie_auth_required")

    def test_symlink_cookie_file_rejection(self):
        """read_cookies must reject symlinked files fail-closed via O_NOFOLLOW."""
        with tempfile.TemporaryDirectory() as tmpdir:
            real_file = os.path.join(tmpdir, "real_cookies.json")
            valid_content = json.dumps({"auth_token": "valid_token", "ct0": "valid_ct0"})
            with open(real_file, "w", encoding="utf-8") as f:
                f.write(valid_content)

            symlink_file = os.path.join(tmpdir, "symlink_cookies.json")
            os.symlink(real_file, symlink_file)

            with self.assertRaises((ValueError, OSError)) as ctx:
                read_cookies(symlink_file)
            # Should fail either at open (O_NOFOLLOW -> ELOOP/EINVAL/OSError) or S_ISREG
            self.assertTrue(
                isinstance(ctx.exception, (OSError, ValueError)),
                f"Expected symlink rejection, got {type(ctx.exception)}"
            )

    def test_reject_directory_as_cookie_file(self):
        """read_cookies must reject directory paths."""
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaises((ValueError, OSError)):
                read_cookies(tmpdir)


class TestRecentTweetBoundaryHardening(unittest.TestCase):
    """Edge Case 3: Tweet age boundaries (>1800s rejected vs <=1800s accepted)."""

    def test_tweet_age_boundary_exact_cutoff(self):
        """Tweets older than 1800s must return False; tweets <= 1800s must return True."""
        now = datetime.datetime.now(datetime.timezone.utc)

        # Within boundary (1790s old) -> True
        tw_fresh = SimpleNamespace(created_at_datetime=now - datetime.timedelta(seconds=1790))
        self.assertTrue(is_recent_tweet(tw_fresh, max_age_seconds=1800))

        # 1799s old -> True
        tw_1799 = SimpleNamespace(created_at_datetime=now - datetime.timedelta(seconds=1799))
        self.assertTrue(is_recent_tweet(tw_1799, max_age_seconds=1800))

        # 1801s old (past boundary > 1800s) -> False
        tw_1801 = SimpleNamespace(created_at_datetime=now - datetime.timedelta(seconds=1801))
        self.assertFalse(is_recent_tweet(tw_1801, max_age_seconds=1800))

        # 3600s old (1 hour) -> False
        tw_3600 = SimpleNamespace(created_at_datetime=now - datetime.timedelta(seconds=3600))
        self.assertFalse(is_recent_tweet(tw_3600, max_age_seconds=1800))

    def test_future_clock_skew_boundary(self):
        """Timestamps > 60s in future must return False; within 60s future must return True."""
        now = datetime.datetime.now(datetime.timezone.utc)

        # 30s in future (acceptable clock skew) -> True
        tw_future_30 = SimpleNamespace(created_at_datetime=now + datetime.timedelta(seconds=30))
        self.assertTrue(is_recent_tweet(tw_future_30, max_age_seconds=1800))

        # 60s in future (exact boundary) -> True
        tw_future_60 = SimpleNamespace(created_at_datetime=now + datetime.timedelta(seconds=60))
        self.assertTrue(is_recent_tweet(tw_future_60, max_age_seconds=1800))

        # 61s in future (excessive future skew) -> False
        tw_future_61 = SimpleNamespace(created_at_datetime=now + datetime.timedelta(seconds=61))
        self.assertFalse(is_recent_tweet(tw_future_61, max_age_seconds=1800))

    def test_string_formatted_timestamps(self):
        """String timestamps in ISO or RFC 2822 format must observe identical boundaries."""
        now = datetime.datetime.now(datetime.timezone.utc)

        # RFC 2822 format (email.utils)
        fresh_rfc = (now - datetime.timedelta(seconds=300)).strftime("%a, %d %b %Y %H:%M:%S +0000")
        stale_rfc = (now - datetime.timedelta(seconds=1850)).strftime("%a, %d %b %Y %H:%M:%S +0000")
        self.assertTrue(is_recent_tweet(SimpleNamespace(created_at=fresh_rfc), max_age_seconds=1800))
        self.assertFalse(is_recent_tweet(SimpleNamespace(created_at=stale_rfc), max_age_seconds=1800))

        # ISO format
        fresh_iso = (now - datetime.timedelta(seconds=500)).isoformat()
        stale_iso = (now - datetime.timedelta(seconds=1810)).isoformat()
        self.assertTrue(is_recent_tweet(SimpleNamespace(created_at=fresh_iso), max_age_seconds=1800))
        self.assertFalse(is_recent_tweet(SimpleNamespace(created_at=stale_iso), max_age_seconds=1800))

    def test_corrupt_and_missing_timestamps_fail_closed(self):
        """Malformed or missing timestamps must return False without unhandled exceptions."""
        corrupt_cases = [
            SimpleNamespace(created_at="not-a-valid-date"),
            SimpleNamespace(created_at=""),
            SimpleNamespace(created_at=None),
            SimpleNamespace(),
            None,
        ]
        for tw in corrupt_cases:
            self.assertFalse(is_recent_tweet(tw), msg=f"Should fail closed for {tw}")


class TestAuthorValidationHomoglyphsAndCasing(unittest.IsolatedAsyncioTestCase):
    """Edge Case 4: Negative author casing, Unicode homoglyphs, and impostor rejection."""

    def test_username_normalization_and_homoglyph_detection(self):
        """Unicode homoglyphs must not match authentic ASCII usernames."""
        latin_user = username("authentic_user")
        cyrillic_user = username("authentic_us\u0435r")  # U+0435 = Cyrillic Small Letter Ie

        self.assertEqual(latin_user, "authentic_user")
        self.assertNotEqual(latin_user, cyrillic_user, "Homoglyph username must NOT collide with Latin username")

    async def test_timeline_verification_rejects_homoglyph_author(self):
        """verify_timeline must reject tweets authored by homoglyph impostors."""
        mock_client = unittest.mock.AsyncMock()
        session = DirectSession(mock_client, {"id": "acc-1", "username": "valid_user", "userId": "12345"})

        # GraphQL returns tweet matching text, but user is homoglyph impostor
        homoglyph_screen_name = "v\u0430lid_user"  # Cyrillic 'а'
        now_str = datetime.datetime.now(datetime.timezone.utc).strftime("%a %b %d %H:%M:%S +0000 %Y")

        mock_gql_response = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-99999",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "legacy": {
                                                                    "id_str": "99999",
                                                                    "full_text": "Target post content to verify",
                                                                    "created_at": now_str,
                                                                    "user_id_str": "12345",
                                                                    "screen_name": homoglyph_screen_name
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }

        mock_client.gql.user_tweets.return_value = (mock_gql_response, None)
        identity = {"userId": "12345", "username": "valid_user"}

        # Patch sleep to speed up test execution
        with unittest.mock.patch("asyncio.sleep", return_value=None):
            res = await session.verify_timeline("Target post content to verify", identity)

        self.assertFalse(res.get("published"), "Homoglyph author tweet must NOT be verified as published")
        self.assertTrue(res.get("ambiguous"), "Outcome must be quarantined to ambiguous")

    async def test_timeline_verification_rejects_mismatched_userid(self):
        """verify_timeline must reject matching text if author user_id belongs to another account."""
        mock_client = unittest.mock.AsyncMock()
        session = DirectSession(mock_client, {"id": "acc-1", "username": "testuser", "userId": "12345"})

        now_str = datetime.datetime.now(datetime.timezone.utc).strftime("%a %b %d %H:%M:%S +0000 %Y")
        mock_gql_response = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-88888",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "legacy": {
                                                                    "id_str": "88888",
                                                                    "full_text": "Another post content",
                                                                    "created_at": now_str,
                                                                    "user_id_str": "999999",  # Attacker user_id
                                                                    "screen_name": "testuser"
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }

        mock_client.gql.user_tweets.return_value = (mock_gql_response, None)
        identity = {"userId": "12345", "username": "testuser"}

        with unittest.mock.patch("asyncio.sleep", return_value=None):
            res = await session.verify_timeline("Another post content", identity)

        self.assertFalse(res.get("published"))
        self.assertTrue(res.get("ambiguous"))


class TestDuplicateTweetErrorNonAccountFailure(unittest.TestCase):
    """Edge Case 5: Error 187 (duplicate tweet) returns non-account failure (None)."""

    def test_twitter_error_187_returns_none(self):
        """Code 187 ('Status is a duplicate.') must return None, not an account failure."""
        payload = {
            "errors": [
                {"code": 187, "message": "Status is a duplicate."}
            ]
        }
        res = classify_x_account_failure(raw_json=payload)
        self.assertIsNone(res, "Error 187 is a content duplication error, not an account failure")

    def test_content_errors_186_385_34_return_none(self):
        """Content error codes (186: length, 385: deleted reply, 34: not found) must return None."""
        for code, msg in [
            (186, "Tweet exceeds 280 characters"),
            (385, "You cannot reply to a deleted tweet"),
            (34, "Sorry, that page does not exist."),
        ]:
            res = classify_x_account_failure(raw_json={"errors": [{"code": code, "message": msg}]})
            self.assertIsNone(res, f"Error code {code} must return None")

    def test_duplicate_tweet_message_with_words_banned_or_rate_limit(self):
        """Text containing duplicate message must not be misclassified as banned."""
        msg = "Status is a duplicate. You previously posted this message."
        res = classify_x_account_failure(errors=[{"code": 187, "message": msg}], text=msg)
        self.assertIsNone(res)


class TestIpcFramingAndTransportFiltering(unittest.IsolatedAsyncioTestCase):
    """Edge Case 6: IPC framing & OnlySocksTransport destination / header filtering."""

    async def test_read_command_overlong_line_raises_eof(self):
        """Input exceeding 1,048,576 bytes must raise EOFError to prevent memory exhaustion."""
        overlong_data = ("x" * 1_048_578) + "\n"
        fake_stdin = io.StringIO(overlong_data)

        with unittest.mock.patch("sys.stdin", fake_stdin):
            with self.assertRaises(EOFError):
                await read_command()

    async def test_read_command_parses_valid_json(self):
        """Valid JSON line must parse cleanly."""
        valid_cmd = json.dumps({"op": "open", "proxy": "socks5h://127.0.0.1:18801"}) + "\n"
        fake_stdin = io.StringIO(valid_cmd)

        with unittest.mock.patch("sys.stdin", fake_stdin):
            cmd = await read_command()
            self.assertEqual(cmd.get("op"), "open")
            self.assertEqual(cmd.get("proxy"), "socks5h://127.0.0.1:18801")

    async def test_only_socks_transport_destination_allowlist(self):
        """Requests to non-allowed domains or ports must raise ValueError('proxy_destination_denied')."""
        import httpx

        client = new_client("socks5h://127.0.0.1:18801")
        transport = client.http._transport

        # Disallowed domain
        bad_request = httpx.Request("GET", "https://evil-analytics.com/leak")
        with self.assertRaises(ValueError) as ctx:
            await transport.handle_async_request(bad_request)
        self.assertEqual(str(ctx.exception), "proxy_destination_denied")

        # Plain HTTP (not https)
        http_request = httpx.Request("GET", "http://x.com/home")
        with self.assertRaises(ValueError) as ctx:
            await transport.handle_async_request(http_request)
        self.assertEqual(str(ctx.exception), "proxy_destination_denied")

        # Disallowed port
        bad_port_request = httpx.Request("GET", "https://api.twitter.com:8443/data")
        with self.assertRaises(ValueError) as ctx:
            await transport.handle_async_request(bad_port_request)
        self.assertEqual(str(ctx.exception), "proxy_destination_denied")

    async def test_only_socks_transport_strips_credentials_for_static_cdn(self):
        """Requests to abs.twimg.com must have cookie, authorization, and csrf headers stripped."""
        import httpx

        client = new_client("socks5h://127.0.0.1:18801")
        transport = client.http._transport

        cdn_request = httpx.Request(
            "GET",
            "https://abs.twimg.com/responsive-web/client-web/bundle.js",
            headers={
                "cookie": "auth_token=secret123; ct0=csrf456",
                "authorization": "Bearer AAAAAAAAAAAAAAAAAAAA",
                "x-csrf-token": "csrf456",
                "accept": "*/*"
            }
        )

        # Mock inner transport
        transport.transport.handle_async_request = unittest.mock.AsyncMock(
            return_value=httpx.Response(200, content=b"/* bundle */")
        )

        response = await transport.handle_async_request(cdn_request)
        self.assertEqual(response.status_code, 200)

        # Verify headers were stripped from cdn_request
        self.assertNotIn("cookie", cdn_request.headers)
        self.assertNotIn("authorization", cdn_request.headers)
        self.assertNotIn("x-csrf-token", cdn_request.headers)
        self.assertIn("accept", cdn_request.headers)


if __name__ == "__main__":
    unittest.main()
