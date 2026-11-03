"""Unit tests verifying that Twikit compat _request preserves raw error details from X GraphQL."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import unittest
from unittest.mock import AsyncMock, MagicMock
from direct_x_compat import compatibility_client
from twikit.errors import TwitterException

class TestCompatApiFailureDetails(unittest.TestCase):
    def test_graphql_errors_preserve_code_message_and_raw_json(self):
        Client = compatibility_client()
        client = Client('chrome')
        
        # Mock response returning GraphQL error 187 (duplicate tweet)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        error_payload = {
            'errors': [
                {'code': 187, 'message': 'Status is a duplicate.'}
            ]
        }
        mock_resp.json.return_value = error_payload
        client.http.request = AsyncMock(return_value=mock_resp)

        with self.assertRaises(TwitterException) as ctx:
            import asyncio
            asyncio.run(client.request('POST', 'https://x.com/i/api/graphql/abc/CreateTweet', json={}))

        exc = ctx.exception
        self.assertEqual(exc.code, 187)
        self.assertEqual(exc.error_code, 187)
        self.assertEqual(exc.raw_json, error_payload)
        self.assertEqual(exc.errors, error_payload['errors'])
        self.assertIn('187', str(exc))
        self.assertIn('Status is a duplicate', str(exc))

    def test_graphql_errors_without_code_preserves_message(self):
        Client = compatibility_client()
        client = Client('chrome')
        
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        error_payload = {
            'errors': [
                {'message': 'Internal X GraphQL error occurred.'}
            ]
        }
        mock_resp.json.return_value = error_payload
        client.http.request = AsyncMock(return_value=mock_resp)

        with self.assertRaises(TwitterException) as ctx:
            import asyncio
            asyncio.run(client.request('POST', 'https://x.com/i/api/graphql/abc/CreateTweet', json={}))

        exc = ctx.exception
        self.assertIsNone(exc.code)
        self.assertEqual(exc.raw_json, error_payload)
        self.assertIn('Internal X GraphQL error occurred.', str(exc))

if __name__ == '__main__':
    unittest.main()
