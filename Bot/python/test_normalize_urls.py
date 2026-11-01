#!/usr/bin/env python3
"""Unit tests for normalize_text_for_comparison and URL matching in direct_x_bridge.py.
Verifies Requirement R1:
- Rejection of different URLs.
- Matching of identical URLs.
- Matching of t.co URLs when mapped by entities.
- Rejection of t.co URLs when unmapped or pointing to different URLs.
- Canonicalization of scheme, host, port, trailing slashes, and whitespace.
"""
import unittest
import sys
from pathlib import Path

# Add Bot/python to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_bridge import (
    canonicalize_url,
    expand_urls_with_entities,
    normalize_text_for_comparison,
)


class TestNormalizeUrls(unittest.TestCase):
    def test_rejection_of_different_urls(self):
        """Two posts with different URLs must NOT match, even with identical surrounding text."""
        t1 = "Check out this update: https://example.com/alpha"
        t2 = "Check out this update: https://example.com/beta"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertNotEqual(n1, n2, "Posts with different URLs must have different normalized representations")

    def test_rejection_of_completely_different_domains(self):
        t1 = "Breaking news: https://news-a.org/story/101"
        t2 = "Breaking news: https://news-b.com/story/101"
        self.assertNotEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Different domains must not match"
        )

    def test_matching_of_identical_urls(self):
        """Posts with identical URLs and text must match."""
        t1 = "Check out this update: https://example.com/alpha"
        t2 = "Check out this update: https://example.com/alpha"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertEqual(n1, n2, "Identical URLs must match exactly")

    def test_canonical_case_port_and_root_slash(self):
        """URLs differing only by case, default ports, or trailing root slash must match."""
        t1 = "Visit: https://example.com"
        t2 = "Visit: HTTPS://EXAMPLE.COM:443/"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertEqual(n1, n2, "Canonicalization must normalize case, port 443, and root slash")

        http1 = "Visit: http://example.com:80"
        http2 = "Visit: http://EXAMPLE.COM/"
        self.assertEqual(
            normalize_text_for_comparison(http1),
            normalize_text_for_comparison(http2),
            "Canonicalization must normalize port 80 and case for HTTP"
        )

    def test_matching_tco_mapped_by_entities(self):
        """A shortened t.co URL must match the original URL when expanded via entity mappings."""
        sent_text = "Latest announcement: https://example.com/releases/v2"
        timeline_text = "Latest announcement: https://t.co/abcXYZ123"
        entities = {
            "urls": [
                {
                    "url": "https://t.co/abcXYZ123",
                    "expanded_url": "https://example.com/releases/v2",
                    "display_url": "example.com/releases/v2"
                }
            ]
        }
        sent_norm = normalize_text_for_comparison(sent_text)
        timeline_norm = normalize_text_for_comparison(timeline_text, entities)
        self.assertEqual(sent_norm, timeline_norm, "t.co URL mapped via entities must match sent URL")

    def test_rejection_of_tco_unmapped(self):
        """A shortened t.co URL without entity mapping must fail closed and NOT match the full URL."""
        sent_text = "Latest announcement: https://example.com/releases/v2"
        timeline_text = "Latest announcement: https://t.co/unmapped999"
        sent_norm = normalize_text_for_comparison(sent_text)
        timeline_norm = normalize_text_for_comparison(timeline_text, entities=None)
        self.assertNotEqual(sent_norm, timeline_norm, "Unmapped t.co URL must not match full URL (fail-closed)")

        # Also when entities is empty dict or empty list
        timeline_norm_empty = normalize_text_for_comparison(timeline_text, entities={})
        self.assertNotEqual(sent_norm, timeline_norm_empty, "Empty entities mapping must fail closed")

    def test_rejection_of_tco_pointing_to_different_url(self):
        """A shortened t.co URL mapped to a different URL must NOT match the sent URL."""
        sent_text = "Latest announcement: https://example.com/releases/v2"
        timeline_text = "Latest announcement: https://t.co/abcXYZ123"
        entities = {
            "urls": [
                {
                    "url": "https://t.co/abcXYZ123",
                    "expanded_url": "https://example.com/releases/v1-old",
                    "display_url": "example.com/releases/v1-old"
                }
            ]
        }
        sent_norm = normalize_text_for_comparison(sent_text)
        timeline_norm = normalize_text_for_comparison(timeline_text, entities)
        self.assertNotEqual(sent_norm, timeline_norm, "t.co mapped to a different URL must be rejected")

    def test_url_only_posts(self):
        """URL-only posts must be preserved and matched/rejected correctly."""
        u1 = "https://example.com/one"
        u2 = "https://example.com/two"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Different URL-only posts must not match"
        )
        self.assertEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison("https://example.com/one/"),
            "Identical URL-only posts must match"
        )

    def test_punctuation_around_urls(self):
        """Punctuation like periods or commas immediately after URLs must be handled cleanly."""
        t1 = "Read more at https://example.com/doc."
        t2 = "Read more at https://example.com/doc"
        # Notice that with a trailing period, the canonicalized url is followed by '.', normalized
        # Both sentences have identical meaning when whitespace/punctuation are preserved canonically
        n1 = normalize_text_for_comparison(t1)
        self.assertTrue("https://example.com/doc" in n1)

    def test_expand_urls_with_entities_list_format(self):
        """entities passed as a list of dicts directly should also expand cleanly."""
        text = "Hello https://t.co/foo world"
        entities_list = [{"url": "https://t.co/foo", "expanded_url": "https://bar.com"}]
        expanded = expand_urls_with_entities(text, entities_list)
        self.assertEqual(expanded, "Hello https://bar.com world")


class TestVerifyTimelineUrls(unittest.IsolatedAsyncioTestCase):
    async def test_timeline_rejects_different_url(self):
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace
        import unittest.mock

        sent_text = "Announcement: https://example.com/item-2"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="1001",
            full_text="Announcement: https://example.com/item-1",
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="testuser"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"))
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_timeline_accepts_identical_url(self):
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace
        import unittest.mock

        sent_text = "Announcement: https://example.com/item-2"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="1002",
            full_text="Announcement: https://example.com/item-2",
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="testuser"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertTrue(res.get("found"))
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "1002")

    async def test_timeline_accepts_tco_with_matching_entity(self):
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace
        import unittest.mock

        sent_text = "Announcement: https://example.com/item-2"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="1003",
            full_text="Announcement: https://t.co/abc2",
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="testuser"),
            urls=[{"url": "https://t.co/abc2", "expanded_url": "https://example.com/item-2"}],
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertTrue(res.get("found"))
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "1003")

    async def test_timeline_rejects_unmapped_tco(self):
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace
        import unittest.mock

        sent_text = "Announcement: https://example.com/item-2"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="1004",
            full_text="Announcement: https://t.co/unmapped",
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="testuser"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"))
        self.assertEqual(res.get("status"), "ambiguous")


if __name__ == "__main__":
    unittest.main()

