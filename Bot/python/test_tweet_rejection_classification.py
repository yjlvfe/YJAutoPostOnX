"""Unit tests for granular classification of X tweet and content rejections."""

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from direct_x_compat import classify_x_tweet_rejection


class TestTweetRejectionClassification(unittest.TestCase):
    def test_duplicate_content_code_187(self):
        rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': 187, 'message': 'Status is a duplicate.'}]})
        self.assertEqual(rej, 'duplicate_content')

    def test_duplicate_content_by_message(self):
        rej = classify_x_tweet_rejection(text='User duplicate status detected')
        self.assertEqual(rej, 'duplicate_content')

    def test_length_exceeded_code_186(self):
        rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': 186, 'message': 'Tweet needs to be a bit shorter.'}]})
        self.assertEqual(rej, 'length_exceeded')

    def test_length_exceeded_by_message(self):
        rej = classify_x_tweet_rejection(text='Text exceeds character limit')
        self.assertEqual(rej, 'length_exceeded')

    def test_content_moderation_code_226(self):
        rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': 226, 'message': 'Automated request detected'}]})
        self.assertEqual(rej, 'content_moderation')

    def test_account_locked_codes(self):
        for code in (326, 353, 399, 241):
            rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': code, 'message': 'Account challenge'}]})
            self.assertEqual(rej, 'account_locked', f"Failed for code {code}")

    def test_account_suspended_codes(self):
        for code in (64, 63, 141):
            rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': code, 'message': 'Suspended'}]})
            self.assertEqual(rej, 'account_suspended', f"Failed for code {code}")

    def test_auth_rejected_codes(self):
        for code in (32, 135, 215, 99, 231):
            rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': code, 'message': 'Auth rejected'}]})
            self.assertEqual(rej, 'auth_rejected', f"Failed for code {code}")

    def test_rate_limit(self):
        rej = classify_x_tweet_rejection(raw_json={'errors': [{'code': 88, 'message': 'Rate limit'}]})
        self.assertEqual(rej, 'rate_limit')
        rej429 = classify_x_tweet_rejection(http_status=429)
        self.assertEqual(rej429, 'rate_limit')

    def test_tweet_tombstone(self):
        raw = {
            'data': {
                'create_tweet': {
                    'tweet_results': {
                        'result': {
                            '__typename': 'TweetTombstone',
                            'tombstone': {'text': {'text': 'This tweet was withheld'}}
                        }
                    }
                }
            }
        }
        rej = classify_x_tweet_rejection(raw_json=raw)
        self.assertEqual(rej, 'tweet_tombstone')

    def test_unrecognized_returns_none(self):
        rej = classify_x_tweet_rejection(raw_json={'data': {}})
        self.assertIsNone(rej)


if __name__ == '__main__':
    unittest.main()
