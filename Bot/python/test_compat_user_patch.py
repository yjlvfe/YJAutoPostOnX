import unittest
from twikit.user import User
from twikit.client.client import Client
import direct_x_compat

class TestCompatUserPatch(unittest.TestCase):
    def setUp(self):
        # Trigger compatibility client initialization
        direct_x_compat.compatibility_client()

    def test_user_initialization_with_empty_description(self):
        client = Client()
        # Data representation mimicking GraphQL response where description has no urls
        data = {
            'rest_id': '123456789',
            'is_blue_verified': False,
            'legacy': {
                'created_at': 'Mon Nov 02 00:00:00 +0000 2026',
                'name': 'Test User',
                'screen_name': 'testuser',
                'profile_image_url_https': 'https://example.com/pic.jpg',
                'location': '',
                'description': 'Bio without urls',
                'entities': {
                    'description': {}  # Empty dict, missing 'urls'
                },
                'pinned_tweet_ids_str': [],
                'verified': False,
                'possibly_sensitive': False,
                'can_dm': True,
                'can_media_tag': True,
                'want_retweets': False,
                'default_profile': True,
                'default_profile_image': False,
                'has_custom_timelines': False,
                'followers_count': 10,
                'fast_followers_count': 0,
                'normal_followers_count': 10,
                'friends_count': 20,
                'favourites_count': 5,
                'listed_count': 0,
                'media_count': 0,
                'statuses_count': 15,
                'is_translator': False,
                'translator_type': 'none',
                'withheld_in_countries': []
            }
        }
        # This must not raise KeyError: 'urls'
        user = User(client, data)
        self.assertEqual(user.screen_name, 'testuser')
        self.assertEqual(user.description_urls, [])
        self.assertEqual(user.urls, [])

    def test_user_initialization_missing_entities_completely(self):
        client = Client()
        data = {
            'rest_id': '987654321',
            'is_blue_verified': False,
            'legacy': {
                'created_at': 'Mon Nov 02 00:00:00 +0000 2026',
                'name': 'No Entities User',
                'screen_name': 'no_entities',
                'profile_image_url_https': 'https://example.com/pic2.jpg',
                'location': '',
                'description': 'No entities at all',
                'pinned_tweet_ids_str': [],
                'verified': False,
                'possibly_sensitive': False,
                'can_dm': True,
                'can_media_tag': True,
                'want_retweets': False,
                'default_profile': True,
                'default_profile_image': False,
                'has_custom_timelines': False,
                'followers_count': 0,
                'fast_followers_count': 0,
                'normal_followers_count': 0,
                'friends_count': 0,
                'favourites_count': 0,
                'listed_count': 0,
                'media_count': 0,
                'statuses_count': 0,
                'is_translator': False,
                'translator_type': 'none',
                'withheld_in_countries': []
            }
        }
        # This must not raise KeyError: 'entities' or KeyError: 'urls'
        user = User(client, data)
        self.assertEqual(user.screen_name, 'no_entities')
        self.assertEqual(user.description_urls, [])
        self.assertEqual(user.urls, [])

if __name__ == '__main__':
    unittest.main()
