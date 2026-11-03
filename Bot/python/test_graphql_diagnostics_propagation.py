"""Regression: X GraphQL details survive account-specific and malformed responses."""
import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock
from direct_x_compat import compatibility_client
from twikit.errors import TwitterException


class GraphQLFailureDetailsTests(unittest.TestCase):
    def _call(self, payload, http=200):
        Client = compatibility_client()
        client = Client('chrome')
        response = MagicMock()
        response.status_code = http
        response.json.return_value = payload
        response.headers = {}
        client.http.request = AsyncMock(return_value=response)
        with self.assertRaises(TwitterException) as context:
            asyncio.run(client.request('POST',
                'https://x.com/i/api/graphql/sample/CreateTweet', json={}))
        return context.exception

    def test_rate_limit_classification_preserves_graphql_code_and_message(self):
        exc = self._call({'errors': [{'code': 88, 'message': 'Rate limit exceeded'}]})
        self.assertEqual(exc.account_failure, 'rate_limit')
        self.assertEqual(exc.code, 88)
        self.assertEqual(exc.x_error_message, 'Rate limit exceeded')
        self.assertEqual(exc.x_response_kind, 'graphql_errors')
        self.assertEqual(exc.http_status, 200)

    def test_graphql_code_zero_does_not_disappear(self):
        exc = self._call({'errors': [{'code': 0, 'message': 'Denied'}]})
        self.assertEqual(exc.code, 0)
        self.assertEqual(exc.error_code, 0)
        self.assertEqual(exc.x_error_message, 'Denied')

    def test_malformed_extensions_cannot_mask_error(self):
        exc = self._call({'errors': [
            {'extensions': None, 'message': 'Malformed response'}]})
        self.assertIsNone(exc.code)
        self.assertEqual(exc.x_error_message, 'Malformed response')
        self.assertEqual(exc.x_response_kind, 'graphql_errors')

    def test_duplicate_content_code_is_retained(self):
        exc = self._call({'errors': [
            {'code': 187, 'message': 'Status is a duplicate.'}]})
        self.assertEqual(exc.code, 187)
        self.assertIn('duplicate', str(exc).lower())
        self.assertEqual(exc.raw_json['errors'][0]['code'], 187)

    def test_x_error_message_is_bounded(self):
        exc = self._call({'errors': [{'code': 186, 'message': 'x' * 5000}]})
        self.assertLessEqual(len(exc.x_error_message), 512)


if __name__ == '__main__':
    unittest.main()
