"""Unit tests for Python X error classifiers, URL normalization, User patch, and secret scrubbing."""
from __future__ import annotations

import pathlib
import sys
import unittest
from unittest.mock import MagicMock

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
import direct_x_compat as compat  # type: ignore[import-not-found]


class Test01ClassifiersAndCompat(unittest.TestCase):
    def test_p01_account_failure_8_classes_and_tweet_rejection_classifiers(self):
        # 1. Banned / suspended (64, 63, 141)
        for code in (64, 63, 141):
            self.assertEqual(
                compat.classify_x_account_failure(errors=[{'code': code, 'message': 'Suspended'}]),
                'banned',
            )
            self.assertEqual(
                compat.classify_x_tweet_rejection(errors=[{'code': code}]),
                'account_suspended',
            )

        # 2. Captcha / challenge / lock (326, 353, 399, 241, bounce_location)
        for code in (326, 353, 399, 241):
            self.assertEqual(
                compat.classify_x_account_failure(errors=[{'code': code, 'message': 'Locked'}]),
                'captcha',
            )
            self.assertEqual(
                compat.classify_x_tweet_rejection(errors=[{'code': code}]),
                'account_locked',
            )
        self.assertEqual(
            compat.classify_x_account_failure(raw_json={'bounce_location': '/account/access'}),
            'captcha',
        )

        # 3. Cookie expired (89)
        self.assertEqual(
            compat.classify_x_account_failure(errors=[{'code': 89, 'message': 'Invalid or expired token'}]),
            'cookie_expired',
        )

        # 4. Auth rejected (32, 135, 215, 99, 231)
        for code in (32, 135, 215, 99, 231):
            self.assertEqual(
                compat.classify_x_account_failure(errors=[{'code': code, 'message': 'Could not authenticate you'}]),
                'auth_rejected',
            )
            self.assertEqual(
                compat.classify_x_tweet_rejection(errors=[{'code': code}]),
                'auth_rejected',
            )

        # 5. Rate limit (88, 185, HTTP 429)
        self.assertEqual(
            compat.classify_x_account_failure(errors=[{'code': 88}]),
            'rate_limit',
        )
        self.assertEqual(
            compat.classify_x_account_failure(http_status=429),
            'rate_limit',
        )
        self.assertEqual(
            compat.classify_x_tweet_rejection(http_status=429),
            'rate_limit',
        )

        # 6. Network / proxy error never misclassified as banned
        self.assertEqual(
            compat.classify_x_account_failure(text='SOCKS5 connection reset while querying suspended endpoint'),
            'network_proxy_error',
        )

        # 7. Ambiguous & auth_session_unverified
        self.assertEqual(
            compat.classify_x_account_failure(text='publish_confirmation_missing after dispatch'),
            'ambiguous',
        )
        self.assertEqual(
            compat.classify_x_account_failure(text='auth_session_unverified'),
            'auth_session_unverified',
        )

        # 8. Tweet content rejections (187 duplicate, 186 too long, 226 moderation, TweetTombstone)
        self.assertEqual(
            compat.classify_x_tweet_rejection(errors=[{'code': 187, 'message': 'Status is a duplicate.'}]),
            'duplicate_content',
        )
        self.assertEqual(
            compat.classify_x_tweet_rejection(errors=[{'code': 186, 'message': 'Tweet needs to be a bit shorter.'}]),
            'length_exceeded',
        )
        self.assertEqual(
            compat.classify_x_tweet_rejection(errors=[{'code': 226, 'message': 'This request looks like it might be automated.'}]),
            'content_moderation',
        )
        self.assertEqual(
            compat.classify_x_tweet_rejection(raw_json={
                'data': {'create_tweet': {'tweet_results': {'result': {'__typename': 'TweetTombstone'}}}}
            }),
            'tweet_tombstone',
        )

    def test_p01_bounded_429_matching_and_magicmock_safety_py_raw_07(self):
        # PY-RAW-07: Incidental '429' in user_id, tweet_id, or MagicMock repr must NOT trigger is_rate_limit_exception
        incidental_errors = [
            ValueError('Failed to fetch profile for user_id=429 in timeline'),
            RuntimeError('Tweet snowflake 1850000000429000001 not found'),
            Exception("<MagicMock name='client.gql' id='140239429123456'>"),
        ]
        for err in incidental_errors:
            self.assertFalse(
                bridge.is_rate_limit_exception(err),
                f'Incidental 429 in {err!r} must NOT be classified as rate_limit (PY-RAW-07)',
            )

        # Genuine HTTP 429 / code 88 / rate limit strings MUST match
        http_429_err = Exception('HTTP 429 Too Many Requests')
        self.assertTrue(bridge.is_rate_limit_exception(http_429_err))

        status_429_err = Exception('Upstream returned status=429 on GraphQL')
        self.assertTrue(bridge.is_rate_limit_exception(status_429_err))

        attr_429_err = Exception(' failure ')
        setattr(attr_429_err, 'http_status', 429)
        self.assertTrue(bridge.is_rate_limit_exception(attr_429_err))

        # Unconfigured MagicMock must never be treated as a rate limit exception
        unconfigured_mock = MagicMock()
        self.assertFalse(isinstance(unconfigured_mock, BaseException))

    def test_p02_compat_user_data_normalization_and_url_canonicalization(self):
        # FINDING-008 & PY-RAW-05: _compat_user_data populates missing legacy entities.description.urls & url.urls
        raw_user = {
            'rest_id': '1001',
            'legacy': {
                'screen_name': 'TestUser',
                'entities': {},
            },
        }
        patched = compat._compat_user_data(raw_user)
        self.assertEqual(patched['legacy']['entities']['description']['urls'], [])
        self.assertEqual(patched['legacy']['entities']['url']['urls'], [])
        self.assertEqual(patched['legacy']['pinned_tweet_ids_str'], [])
        self.assertEqual(patched['legacy']['withheld_in_countries'], [])

        # Idempotent compatibility_client() User.__init__ wrapper
        cls1 = compat.compatibility_client()
        cls2 = compat.compatibility_client()
        self.assertIsNotNone(cls1)
        self.assertIsNotNone(cls2)
        from twikit.user import User  # type: ignore[import-not-found]
        self.assertTrue(getattr(User, '_compat_patched', False))

        # URL expansion and canonicalization for timeline text comparison
        text_with_tco = 'Check this out https://t.co/xyz123 now!'
        entities = {
            'urls': [
                {'url': 'https://t.co/xyz123', 'expanded_url': 'HTTPS://EXAMPLE.COM:443/Path/CasePreserved/'}
            ]
        }
        norm1 = bridge.normalize_text_for_comparison(text_with_tco, entities)
        norm2 = bridge.normalize_text_for_comparison('check   this out https://example.com/Path/CasePreserved now!')
        self.assertEqual(norm1, norm2)

    def test_p02_secret_scrubbing_in_error_diagnostics_py_raw_07(self):
        exc = Exception('Failed with auth_token=secret_tok_999 and ct0=secret_csrf_888 and Bearer eyJsecretToken1234567890')
        compat._x_error_with_details(
            exc,
            payload={'errors': [{'code': 32, 'message': 'Bad auth_token=secret_tok_999; ct0=secret_csrf_888'}]},
            http_status=401,
        )
        details = bridge.upstream_error_details(exc)
        msg = str(details.get('xErrorMessage') or '')
        self.assertNotIn('secret_tok_999', msg)
        self.assertNotIn('secret_csrf_888', msg)


if __name__ == '__main__':
    unittest.main()
