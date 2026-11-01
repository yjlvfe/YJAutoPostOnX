"""Unit tests for Phase P2 Track 2:
FINDING-012, FINDING-010, FINDING-008, FINDING-007
"""
import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock

# Add python dir to path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_compat import (
    _compat_user_data,
    classify_x_account_failure,
    compatibility_client,
)
from direct_x_bridge import (
    _compat_user_data as bridge_compat_user_data,
    DirectSession,
)


class TestFinding012Requirements(unittest.TestCase):
    def test_curl_cffi_in_requirements(self):
        req_file = Path(__file__).resolve().parent.parent / 'requirements-direct-x.txt'
        content = req_file.read_text(encoding='utf-8')
        self.assertIn('curl_cffi==0.16.3', content)

    def test_curl_cffi_importable(self):
        import curl_cffi
        self.assertEqual(curl_cffi.__version__, '0.16.3')


class TestFinding010ClassifyAccountFailure(unittest.TestCase):
    def test_strict_error_codes(self):
        self.assertEqual(classify_x_account_failure(raw_json={'errors': [{'code': 64}]}), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'errors': [{'code': 63}]}), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'errors': [{'code': 141}]}), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 64}]), 'banned')
        self.assertEqual(classify_x_account_failure(errors=[{'extensions': {'code': 63}}]), 'banned')

    def test_suspended_regex_matching(self):
        self.assertEqual(classify_x_account_failure(text='User has been suspended.'), 'banned')
        self.assertEqual(classify_x_account_failure(text='This account has been suspended.'), 'banned')
        self.assertEqual(classify_x_account_failure(text='account suspended'), 'banned')
        self.assertEqual(classify_x_account_failure(text='Your account is suspended and not permitted'), 'banned')
        self.assertEqual(classify_x_account_failure(text='User is suspended.'), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'message': 'User has been suspended'}), 'banned')
        self.assertEqual(classify_x_account_failure(raw_json={'reason': 'Suspended'}), 'banned')

    def test_unsuspended_never_triggers_banned(self):
        # 'unsuspended' must NEVER trigger 'banned'
        self.assertIsNone(classify_x_account_failure(text='unsuspended'))
        self.assertIsNone(classify_x_account_failure(text='User has been unsuspended.'))
        self.assertIsNone(classify_x_account_failure(text='My account was unsuspended today'))
        self.assertIsNone(classify_x_account_failure(raw_json={'message': 'The user is unsuspended'}))

    def test_tweet_content_mentioning_banned_never_triggers_banned(self):
        # Tweet contents mentioning banned or ban must NEVER trigger false 'banned'
        self.assertIsNone(classify_x_account_failure(text='banned'))
        self.assertIsNone(classify_x_account_failure(text='Why was this user banned from the discord?'))
        self.assertIsNone(classify_x_account_failure(text='Crypto update: Bitcoin banned in Nigeria'))
        self.assertIsNone(classify_x_account_failure(text='Many accounts were banned last month'))
        self.assertIsNone(classify_x_account_failure(raw_json={'errors': [{'message': 'Invalid tweet: banned word'}]}))

    def test_captcha_and_auth_codes_preserved(self):
        self.assertEqual(classify_x_account_failure(errors=[{'code': 326}]), 'captcha')
        self.assertEqual(classify_x_account_failure(text='login_verification required'), 'captcha')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 32}]), 'auth')
        self.assertEqual(classify_x_account_failure(errors=[{'code': 89}]), 'auth')


class TestFinding008CompatUserData(unittest.TestCase):
    def test_both_imports_available(self):
        self.assertIs(_compat_user_data, bridge_compat_user_data)

    def test_missing_entities(self):
        data = {'rest_id': '123', 'legacy': {'name': 'test'}}
        patched = _compat_user_data(data)
        self.assertIn('entities', patched['legacy'])
        self.assertEqual(patched['legacy']['entities']['description']['urls'], [])
        self.assertEqual(patched['legacy']['entities']['url']['urls'], [])

    def test_explicit_none_entities(self):
        # Tip from Critic/Parent: entities['url'] or description is explicitly None
        data = {
            'rest_id': '123',
            'legacy': {
                'name': 'test',
                'entities': {'url': None, 'description': None}
            }
        }
        patched = _compat_user_data(data)
        self.assertEqual(patched['legacy']['entities']['description'], {'urls': []})
        self.assertEqual(patched['legacy']['entities']['url'], {'urls': []})
        self.assertIsInstance(patched['legacy']['entities']['description']['urls'], list)
        self.assertIsInstance(patched['legacy']['entities']['url']['urls'], list)

    def test_empty_dict_entities(self):
        data = {
            'rest_id': '123',
            'legacy': {
                'name': 'test',
                'entities': {'url': {}, 'description': {}}
            }
        }
        patched = _compat_user_data(data)
        self.assertEqual(patched['legacy']['entities']['description']['urls'], [])
        self.assertEqual(patched['legacy']['entities']['url']['urls'], [])

    def test_none_urls_inside_dict(self):
        data = {
            'rest_id': '123',
            'legacy': {
                'name': 'test',
                'entities': {
                    'url': {'urls': None},
                    'description': {'urls': None}
                }
            }
        }
        patched = _compat_user_data(data)
        self.assertEqual(patched['legacy']['entities']['description']['urls'], [])
        self.assertEqual(patched['legacy']['entities']['url']['urls'], [])

    def test_nested_graphql_structures(self):
        data = {
            'user': {
                'result': {
                    'rest_id': '456',
                    'legacy': {'name': 'nested', 'entities': {'url': {}}}
                }
            }
        }
        patched = _compat_user_data(data)
        inner = patched['user']['result']['legacy']['entities']
        self.assertEqual(inner['description']['urls'], [])
        self.assertEqual(inner['url']['urls'], [])

    def test_twikit_user_constructor_safety(self):
        from twikit.user import User
        client = MagicMock()
        user_data = {
            'rest_id': '789',
            'is_blue_verified': False,
            'legacy': {
                'created_at': 'Mon Jan 01 00:00:00 +0000 2024',
                'name': 'NoUrlUser',
                'screen_name': 'nourluser',
                'profile_image_url_https': 'https://example.com/p.jpg',
                'location': '',
                'description': 'Bio without urls',
                'entities': {'url': None},  # Notice None url
                'verified': False,
                'possibly_sensitive': False,
                'can_dm': True,
                'can_media_tag': True,
                'want_retweets': True,
                'default_profile': True,
                'default_profile_image': False,
                'has_custom_timelines': False,
                'followers_count': 10,
                'fast_followers_count': 0,
                'normal_followers_count': 10,
                'friends_count': 5,
                'favourites_count': 2,
                'listed_count': 0,
                'media_count': 0,
                'statuses_count': 1,
                'is_translator': False,
                'translator_type': 'none',
            }
        }
        # Must not raise KeyError: 'urls' or AttributeError
        user = User(client, _compat_user_data(user_data))
        self.assertEqual(user.description_urls, [])
        self.assertEqual(user.urls, [])


class TestFinding007LiveVerification(unittest.IsolatedAsyncioTestCase):
    async def test_use_cache_does_not_bypass_suspension_check(self):
        from twikit.errors import UserUnavailable

        client = MagicMock()
        client.get_cookies.return_value = {'twid': 'u%3D123456'}
        # Simulate get_user_by_id raising UserUnavailable with account_failure = 'banned'
        err = UserUnavailable('User has been suspended')
        err.account_failure = 'banned'
        client.get_user_by_id = AsyncMock(side_effect=err)

        session = DirectSession(client, {
            'username': 'testuser',
            'userId': '123456',
            'use_cache': True,
        })

        with self.assertRaises(UserUnavailable) as cm:
            await session._identity_once()
        self.assertEqual(getattr(cm.exception, 'account_failure', None), 'banned')

    async def test_use_cache_performs_profile_fetch_and_authenticates_active_account(self):
        client = MagicMock()
        client.get_cookies.return_value = {'twid': 'u%3D123456'}
        mock_user = MagicMock()
        mock_user.id = '123456'
        mock_user.screen_name = 'testuser'
        client.get_user_by_id = AsyncMock(return_value=mock_user)

        session = DirectSession(client, {
            'username': 'testuser',
            'userId': '123456',
            'use_cache': True,
        })

        result = await session._identity_once()
        self.assertEqual(result['state'], 'authenticated')
        self.assertTrue(result['authenticated'])
        self.assertEqual(result['username'], 'testuser')
        self.assertEqual(result['userId'], '123456')
        client.get_user_by_id.assert_awaited_once_with('123456')

    async def test_get_user_by_id_detects_user_unavailable_suspended(self):
        # Test CompatibilityClient.get_user_by_id with suspended response
        ClientCls = compatibility_client()
        client = MagicMock(spec=ClientCls)
        client.gql = MagicMock()
        client.gql.user_by_rest_id = AsyncMock(return_value=(
            {
                'data': {
                    'user': {
                        'result': {
                            '__typename': 'UserUnavailable',
                            'reason': 'Suspended',
                            'message': 'User has been suspended'
                        }
                    }
                }
            },
            MagicMock()
        ))

        from twikit.errors import UserUnavailable
        with self.assertRaises(UserUnavailable) as cm:
            await ClientCls.get_user_by_id(client, '123456')
        self.assertEqual(getattr(cm.exception, 'account_failure', None), 'banned')


if __name__ == '__main__':
    unittest.main()
