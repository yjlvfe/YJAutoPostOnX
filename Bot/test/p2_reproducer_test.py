#!/usr/bin/env python3
"""Phase P2 Isolated Pre-Fix Reproducer & Verification Test Suite.

Findings Covered:
1. FINDING-010: Naive substring matching falsely classifying 'unsuspended' or tweet
   body with 'banned' as account failure 'banned' in `direct_x_compat.py`.
2. FINDING-008: Missing `urls` entity in GraphQL user responses causing `KeyError: 'urls'`
   in Twikit/User, and AttributeError in pre-fix _compat_user_data when url is None.

Safety Contract:
- Does NOT interact with or restart yj-telegram-bot.service (PID 289644).
- Operates strictly with mock data and isolated in-memory objects.
"""

import sys
import unittest
from pathlib import Path

# Add Bot/python to sys.path
BOT_PYTHON = Path(__file__).resolve().parent.parent / "python"
sys.path.insert(0, str(BOT_PYTHON))

from direct_x_compat import (
    classify_x_account_failure,
    _compat_user_data,
    compatibility_client,
)
from twikit.user import User
from twikit.errors import TwitterException, UserUnavailable


def prefix_classify_x_account_failure(raw_json=None, errors=None, text=''):
    """Pre-fix reference implementation of classify_x_account_failure (commit 8c8d075).

    Demonstrates the exact naive substring matching flaw:
        combined = ' '.join(messages).lower()
        if codes & {64, 63, 141} or 'suspended' in combined or 'banned' in combined:
            return 'banned'
    """
    if isinstance(raw_json, dict) and not errors:
        errors = raw_json.get('errors', [])
    errors = errors if isinstance(errors, list) else []

    codes = set()
    messages = []
    has_bounce = False

    if isinstance(raw_json, dict):
        if 'bounce_location' in raw_json:
            has_bounce = True
        if isinstance(raw_json.get('message'), str):
            messages.append(raw_json['message'])

    for e in errors:
        if isinstance(e, dict):
            if type(e.get('code')) is int:
                codes.add(e['code'])
            ext_code = e.get('extensions', {}).get('code')
            if type(ext_code) is int:
                codes.add(ext_code)
            if 'bounce_location' in e:
                has_bounce = True
            msg = e.get('message')
            if isinstance(msg, str):
                messages.append(msg)

    if text and isinstance(text, str):
        messages.append(text)

    combined = ' '.join(messages).lower()

    # Pre-fix naive substring check:
    if codes & {64, 63, 141} or 'suspended' in combined or 'banned' in combined:
        return 'banned'

    captcha_kw = (
        'captcha', 'arkose', 'funcaptcha', 'verification_required',
        'verification required', 'challenge_required', 'challenge required',
        'temporarily locked', 'unlock your account', 'account/access',
        'login_verification', 'user is locked', 'account is locked'
    )
    if codes & {326, 353, 399, 241} or has_bounce or any(w in combined for w in captcha_kw):
        return 'captcha'

    if codes & {32, 89, 135, 215}:
        return 'auth'

    return None


def prefix_compat_user_data(data):
    """Pre-fix reference implementation of _compat_user_data (commit 8c8d075).

    Demonstrates the flaw where entities['url'] = None is not replaced by setdefault:
        entities.setdefault('url', {'urls': []})
    """
    if not isinstance(data, dict):
        return data
    result = dict(data)
    legacy = result.get('legacy')
    if isinstance(legacy, dict):
        legacy = dict(legacy)
        entities = legacy.get('entities', {})
        if isinstance(entities, dict):
            entities = dict(entities)
            description = entities.get('description', {})
            if isinstance(description, dict):
                description = dict(description)
                description.setdefault('urls', [])
                entities['description'] = description
            else:
                entities['description'] = {'urls': []}
            entities.setdefault('url', {'urls': []})
            legacy['entities'] = entities
        else:
            legacy['entities'] = {'description': {'urls': []}, 'url': {'urls': []}}
        legacy.setdefault('pinned_tweet_ids_str', [])
        legacy.setdefault('withheld_in_countries', [])
        result['legacy'] = legacy
    return result


class TestFinding010NaiveSubstringMatching(unittest.TestCase):
    """FINDING-010: Naive Substring Matching Reproducer & Verification Tests.

    In pre-fix direct_x_compat.py (lines 105-108):
        combined = ' '.join(messages).lower()
        if codes & {64, 63, 141} or 'suspended' in combined or 'banned' in combined:
            return 'banned'

    Defect:
    - 'suspended' in 'unsuspended' is True -> falsely classifies unsuspended accounts as banned.
    - 'banned' in tweet body text -> falsely classifies legitimate tweets discussing banned topics as banned.
    - Error response echoing the tweet content triggers false permanent account banning.
    """

    def test_reproduce_prefix_bug_unsuspended_falsely_banned(self):
        """Empirical demonstration of pre-fix defect:

        In the pre-fix algorithm, 'unsuspended' matches 'suspended' -> returns 'banned'.
        """
        benign_text_1 = "Your account has been unsuspended after review."
        benign_text_2 = "Good news, the account is now unsuspended!"

        res_1 = prefix_classify_x_account_failure(text=benign_text_1)
        res_2 = prefix_classify_x_account_failure(text=benign_text_2)

        print(f"\n[FINDING-010 Pre-fix Defect] text='{benign_text_1}' -> returns '{res_1}' (BUG: falsely banned)")
        print(f"[FINDING-010 Pre-fix Defect] text='{benign_text_2}' -> returns '{res_2}' (BUG: falsely banned)")

        self.assertEqual(res_1, "banned")
        self.assertEqual(res_2, "banned")

    def test_reproduce_prefix_bug_tweet_body_mentioning_banned(self):
        """Empirical demonstration of pre-fix defect:

        In the pre-fix algorithm, tweet text mentioning 'banned' triggers false account ban.
        """
        tweet_body = "We are hosting an open discussion on banned books and censorship."
        res_text = prefix_classify_x_account_failure(text=tweet_body)

        err_with_tweet = {
            "errors": [
                {
                    "code": 187,
                    "message": "Status is a duplicate: We are hosting an open discussion on banned books",
                }
            ]
        }
        res_err = prefix_classify_x_account_failure(raw_json=err_with_tweet)

        print(f"[FINDING-010 Pre-fix Defect] tweet_body='{tweet_body}' -> returns '{res_text}' (BUG: falsely banned)")
        print(f"[FINDING-010 Pre-fix Defect] duplicate error with 'banned' -> returns '{res_err}' (BUG: falsely banned)")

        self.assertEqual(res_text, "banned")
        self.assertEqual(res_err, "banned")

    def test_verify_fix_classify_x_account_failure(self):
        """Verification of the fixed classify_x_account_failure in direct_x_compat.py:

        - 'unsuspended' must return None (account is NOT banned).
        - tweet body mentioning 'banned' must return None (account is NOT banned).
        - legitimate suspension codes (64, 63, 141) and explicit suspension messages return 'banned'.
        """
        # Benign phrases must NOT trigger banned
        self.assertIsNone(classify_x_account_failure(text="Your account has been unsuspended after review."))
        self.assertIsNone(classify_x_account_failure(text="unsuspended"))
        self.assertIsNone(classify_x_account_failure(text="Discussing banned books and literature."))
        self.assertIsNone(classify_x_account_failure(text="banned"))
        self.assertIsNone(classify_x_account_failure(raw_json={"errors": [{"code": 187, "message": "Duplicate tweet: banned"}]}))

        # Legitimate suspensions must still be classified as 'banned'
        self.assertEqual(classify_x_account_failure(raw_json={"errors": [{"code": 64, "message": "Your account is suspended."}]}), "banned")
        self.assertEqual(classify_x_account_failure(raw_json={"errors": [{"code": 63, "message": "User has been suspended."}]}), "banned")
        self.assertEqual(classify_x_account_failure(raw_json={"errors": [{"code": 141, "message": "User is suspended."}]}), "banned")
        self.assertEqual(classify_x_account_failure(text="This account has been suspended."), "banned")
        self.assertEqual(classify_x_account_failure(raw_json={"reason": "Suspended"}), "banned")

        print("[FINDING-010 Fixed Verification] classify_x_account_failure passed all false-positive and legitimate suspension tests!")


class TestFinding008GraphQLMissingUrlsKeyError(unittest.TestCase):
    """FINDING-008: Missing 'urls' entity in GraphQL user responses.

    In upstream Twikit/User.__init__:
        self.description_urls: list = legacy['entities']['description']['urls']
        self.urls: list = legacy['entities'].get('url', {}).get('urls')

    Defect:
    1. If legacy['entities']['description'] has no 'urls' key, Twikit raises KeyError: 'urls'.
    2. If legacy['entities'] is empty or missing, Twikit raises KeyError: 'description' or KeyError: 'entities'.
    3. In pre-fix _compat_user_data:
           entities.setdefault('url', {'urls': []})
       If entities['url'] is None, setdefault does NOT replace None!
       Then legacy['entities'].get('url', {}).get('urls') evaluates to:
           None.get('urls') -> raises AttributeError: 'NoneType' object has no attribute 'get'.
    """

    def setUp(self):
        class MockClient:
            pass
        self.client = MockClient()

    def test_reproduce_twikit_upstream_key_error_on_missing_urls(self):
        """Empirical demonstration: Upstream Twikit User raises KeyError: 'urls'

        when GraphQL user has no URLs in bio/description.
        """
        raw_user_data = {
            "rest_id": "999888777",
            "is_blue_verified": False,
            "legacy": {
                "created_at": "Sun Oct 18 12:00:00 +0000 2020",
                "name": "Target Account",
                "screen_name": "target_account",
                "profile_image_url_https": "https://pbs.twimg.com/profile_images/1/pic.jpg",
                "location": "Riyadh",
                "description": "A bio without any links in it",
                "entities": {
                    "description": {}  # Missing 'urls' key from GraphQL response
                },
                "pinned_tweet_ids_str": [],
                "verified": False,
                "possibly_sensitive": False,
                "can_dm": True,
                "can_media_tag": True,
                "want_retweets": False,
                "default_profile": True,
                "default_profile_image": False,
                "has_custom_timelines": False,
                "followers_count": 100,
                "fast_followers_count": 0,
                "normal_followers_count": 100,
                "friends_count": 50,
                "favourites_count": 20,
                "listed_count": 2,
                "media_count": 10,
                "statuses_count": 45,
                "is_translator": False,
                "translator_type": "none",
                "withheld_in_countries": [],
            },
        }

        with self.assertRaises(KeyError) as ctx:
            User(self.client, raw_user_data)

        print(f"\n[FINDING-008 Upstream Twikit Defect] User raised expected KeyError: {repr(ctx.exception)}")
        self.assertIn("urls", str(ctx.exception))

    def test_reproduce_twikit_upstream_key_error_on_missing_entities(self):
        """Upstream Twikit User raises KeyError: 'entities' when legacy has no entities."""
        raw_user_data = {
            "rest_id": "999888777",
            "is_blue_verified": False,
            "legacy": {
                "created_at": "Sun Oct 18 12:00:00 +0000 2020",
                "name": "Target Account",
                "screen_name": "target_account",
                "profile_image_url_https": "https://pbs.twimg.com/profile_images/1/pic.jpg",
                "location": "",
                "description": "",
                # 'entities' completely missing
                "pinned_tweet_ids_str": [],
                "verified": False,
                "possibly_sensitive": False,
                "can_dm": False,
                "can_media_tag": False,
                "want_retweets": False,
                "default_profile": False,
                "default_profile_image": False,
                "has_custom_timelines": False,
                "followers_count": 0,
                "fast_followers_count": 0,
                "normal_followers_count": 0,
                "friends_count": 0,
                "favourites_count": 0,
                "listed_count": 0,
                "media_count": 0,
                "statuses_count": 0,
                "is_translator": False,
                "translator_type": "none",
                "withheld_in_countries": [],
            },
        }

        with self.assertRaises(KeyError) as ctx:
            User(self.client, raw_user_data)

        print(f"[FINDING-008 Upstream Twikit Defect] User raised expected KeyError: {repr(ctx.exception)}")
        self.assertIn("entities", str(ctx.exception))

    def test_reproduce_prefix_compat_user_data_attribute_error_when_url_is_none(self):
        """Empirical demonstration of pre-fix _compat_user_data flaw:

        When entities['url'] is explicitly None, pre-fix setdefault('url', ...) leaves
        it as None, causing AttributeError: 'NoneType' object has no attribute 'get' in User.__init__.
        """
        raw_user_data_url_none = {
            "rest_id": "999888777",
            "is_blue_verified": False,
            "legacy": {
                "created_at": "Sun Oct 18 12:00:00 +0000 2020",
                "name": "Target Account",
                "screen_name": "target_account",
                "profile_image_url_https": "https://pbs.twimg.com/profile_images/1/pic.jpg",
                "location": "",
                "description": "Bio text",
                "entities": {
                    "description": {"urls": []},
                    "url": None,  # Common in Twitter GraphQL responses
                },
                "pinned_tweet_ids_str": [],
                "verified": False,
                "possibly_sensitive": False,
                "can_dm": False,
                "can_media_tag": False,
                "want_retweets": False,
                "default_profile": False,
                "default_profile_image": False,
                "has_custom_timelines": False,
                "followers_count": 0,
                "fast_followers_count": 0,
                "normal_followers_count": 0,
                "friends_count": 0,
                "favourites_count": 0,
                "listed_count": 0,
                "media_count": 0,
                "statuses_count": 0,
                "is_translator": False,
                "translator_type": "none",
                "withheld_in_countries": [],
            },
        }

        # Apply pre-fix _compat_user_data
        prefix_compat_result = prefix_compat_user_data(raw_user_data_url_none)
        self.assertIsNone(prefix_compat_result["legacy"]["entities"]["url"], "Pre-fix setdefault leaves url as None")

        with self.assertRaises(AttributeError) as ctx:
            User(self.client, prefix_compat_result)

        print(f"[FINDING-008 Pre-fix Defect] Pre-fix _compat_user_data resulted in AttributeError: {repr(ctx.exception)}")
        self.assertIn("object has no attribute 'get'", str(ctx.exception))

    def test_verify_fixed_compat_user_data(self):
        """Verification of the fixed _compat_user_data in direct_x_compat.py:

        Ensures that regardless of whether 'entities', 'description', or 'url' are missing,
        empty dicts, or explicitly None, _compat_user_data normalizes them into lists,
        and User(client, patched) initializes cleanly with zero exceptions.
        """
        cases = [
            # Case 1: url and description are None
            {
                "rest_id": "111",
                "is_blue_verified": False,
                "legacy": {
                    "created_at": "Sun Oct 18 12:00:00 +0000 2020", "name": "A", "screen_name": "a",
                    "profile_image_url_https": "", "location": "", "description": "",
                    "entities": {"url": None, "description": None},
                    "pinned_tweet_ids_str": [], "verified": False, "possibly_sensitive": False,
                    "can_dm": False, "can_media_tag": False, "want_retweets": False,
                    "default_profile": False, "default_profile_image": False, "has_custom_timelines": False,
                    "followers_count": 0, "fast_followers_count": 0, "normal_followers_count": 0,
                    "friends_count": 0, "favourites_count": 0, "listed_count": 0, "media_count": 0,
                    "statuses_count": 0, "is_translator": False, "translator_type": "none", "withheld_in_countries": [],
                }
            },
            # Case 2: entities missing completely
            {
                "rest_id": "222",
                "is_blue_verified": False,
                "legacy": {
                    "created_at": "Sun Oct 18 12:00:00 +0000 2020", "name": "B", "screen_name": "b",
                    "profile_image_url_https": "", "location": "", "description": "",
                    "pinned_tweet_ids_str": [], "verified": False, "possibly_sensitive": False,
                    "can_dm": False, "can_media_tag": False, "want_retweets": False,
                    "default_profile": False, "default_profile_image": False, "has_custom_timelines": False,
                    "followers_count": 0, "fast_followers_count": 0, "normal_followers_count": 0,
                    "friends_count": 0, "favourites_count": 0, "listed_count": 0, "media_count": 0,
                    "statuses_count": 0, "is_translator": False, "translator_type": "none", "withheld_in_countries": [],
                }
            },
            # Case 3: entities['description'] is empty dict {} (missing 'urls')
            {
                "rest_id": "333",
                "is_blue_verified": False,
                "legacy": {
                    "created_at": "Sun Oct 18 12:00:00 +0000 2020", "name": "C", "screen_name": "c",
                    "profile_image_url_https": "", "location": "", "description": "hello",
                    "entities": {"description": {}},
                    "pinned_tweet_ids_str": [], "verified": False, "possibly_sensitive": False,
                    "can_dm": False, "can_media_tag": False, "want_retweets": False,
                    "default_profile": False, "default_profile_image": False, "has_custom_timelines": False,
                    "followers_count": 0, "fast_followers_count": 0, "normal_followers_count": 0,
                    "friends_count": 0, "favourites_count": 0, "listed_count": 0, "media_count": 0,
                    "statuses_count": 0, "is_translator": False, "translator_type": "none", "withheld_in_countries": [],
                }
            },
        ]

        for i, raw_case in enumerate(cases):
            patched = _compat_user_data(raw_case)
            user = User(self.client, patched)
            self.assertEqual(user.urls, [])
            self.assertEqual(user.description_urls, [])
            self.assertEqual(user.id, raw_case["rest_id"])

        print("[FINDING-008 Fixed Verification] _compat_user_data passed all missing/None entities cases!")


if __name__ == "__main__":
    print("=" * 70)
    print("RUNNING PHASE P2 REPRODUCER TESTS: FINDING-010 & FINDING-008")
    print("=" * 70)
    unittest.main(verbosity=2)
