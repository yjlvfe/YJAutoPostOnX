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
import unittest.mock
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

    def test_matching_identical_case_sensitive_path_query_fragment(self):
        """Identical URL paths, query parameters, and fragments must match even when surrounding text casing differs."""
        t1 = "Check this: https://example.com/DeepPath/Article-1?Param=ABC&Ref=XYZ#SectionA"
        t2 = "CHECK THIS: https://example.com/DeepPath/Article-1?Param=ABC&Ref=XYZ#SectionA"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertEqual(n1, n2, "Identical case-sensitive path, query, and fragment must match")

    def test_scheme_host_case_insensitivity(self):
        """URL scheme and domain must be case-insensitive."""
        t1 = "Visit: HTTPS://WWW.EXAMPLE.COM/PathA"
        t2 = "Visit: https://www.example.com/PathA"
        self.assertEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Scheme and host must be case-insensitive"
        )

    def test_non_default_ports_preserved(self):
        """Non-default ports such as :8080 and :8443 must be preserved and distinct."""
        u_8080 = "http://example.com:8080/Resource"
        u_plain = "http://example.com/Resource"
        self.assertEqual(normalize_text_for_comparison(u_8080), normalize_text_for_comparison(u_8080))
        self.assertNotEqual(normalize_text_for_comparison(u_8080), normalize_text_for_comparison(u_plain))

        u_8443 = "https://example.com:8443/Resource"
        u_ssl_plain = "https://example.com/Resource"
        self.assertEqual(normalize_text_for_comparison(u_8443), normalize_text_for_comparison(u_8443))
        self.assertNotEqual(normalize_text_for_comparison(u_8443), normalize_text_for_comparison(u_ssl_plain))

    def test_tco_expansion_preserving_destination_path_casing(self):
        """t.co expansion via entities must preserve destination URL path and query casing."""
        sent = "Read: https://example.com/CamelCasePath/Article?Id=VarA#FragB"
        timeline = "Read: https://t.co/short123"
        entities = {
            "urls": [
                {
                    "url": "https://t.co/short123",
                    "expanded_url": "https://example.com/CamelCasePath/Article?Id=VarA#FragB"
                }
            ]
        }
        self.assertEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities),
            "Expanded destination URL path/query/fragment casing must match sent text"
        )

    def test_rejection_of_different_case_path(self):
        """URLs differing only in path casing must NOT match."""
        t1 = "https://example.com/ArticlePath"
        t2 = "https://example.com/articlepath"
        self.assertNotEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Path casing difference must be rejected"
        )

    def test_rejection_of_different_case_query(self):
        """URLs differing only in query parameter casing must NOT match."""
        t1 = "https://example.com/search?Query=Alpha"
        t2 = "https://example.com/search?query=alpha"
        self.assertNotEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Query parameter casing difference must be rejected"
        )

    def test_rejection_of_different_case_fragment(self):
        """URLs differing only in fragment casing must NOT match."""
        t1 = "https://example.com/doc#SectionOne"
        t2 = "https://example.com/doc#sectionone"
        self.assertNotEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Fragment casing difference must be rejected"
        )


class TestVerifyTimelineUrls(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._sleep_patch = unittest.mock.patch("asyncio.sleep", new_callable=unittest.mock.AsyncMock)
        self._sleep_patch.start()

    async def asyncTearDown(self):
        self._sleep_patch.stop()

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

    async def test_timeline_accepts_graphql_matching_author(self):
        """GraphQL user_tweets with matching author in core.user_results.result must be accepted."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Headline: https://example.com/News/101"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        gql_payload = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-3001",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "core": {
                                                                    "user_results": {
                                                                        "result": {
                                                                            "rest_id": "123",
                                                                            "legacy": {"screen_name": "testuser"}
                                                                        }
                                                                    }
                                                                },
                                                                "legacy": {
                                                                    "id_str": "3001",
                                                                    "full_text": sent_text,
                                                                    "created_at": now_str,
                                                                    "user_id_str": "123",
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
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertTrue(res.get("found"), "Matching GraphQL tweet must be found")
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "3001")

    async def test_timeline_accepts_graphql_wrapped_tweet_matching_author(self):
        """GraphQL tweet wrapped in TweetWithVisibilityResults (result['tweet']) must be unwrapped and accepted."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Headline: https://example.com/News/102"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        gql_payload = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-3002",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "__typename": "TweetWithVisibilityResults",
                                                                "tweet": {
                                                                    "core": {
                                                                        "user_results": {
                                                                            "result": {
                                                                                "rest_id": "123",
                                                                                "legacy": {"screen_name": "testuser"}
                                                                            }
                                                                        }
                                                                    },
                                                                    "legacy": {
                                                                        "id_str": "3002",
                                                                        "full_text": sent_text,
                                                                        "created_at": now_str,
                                                                        "user_id_str": "123",
                                                                    }
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
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertTrue(res.get("found"), "Wrapped GraphQL tweet must be found")
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "3002")

    async def test_timeline_rejects_different_case_url_path(self):
        """Timeline verification must reject tweet when URL path differs in casing."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Read: https://example.com/ImportantPath"
        timeline_text = "Read: https://example.com/importantpath"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="3003",
            full_text=timeline_text,
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
        self.assertFalse(res.get("found"), "Path casing difference must NOT match in timeline")
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_timeline_rejects_mismatched_author_screen_name(self):
        """Timeline verification must fail-closed when author screen_name mismatches authenticated user."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Announcement: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="3004",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="imposter"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Mismatched screen_name must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_timeline_rejects_mismatched_author_user_id(self):
        """Timeline verification must fail-closed when author user_id mismatches authenticated user."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Announcement: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="3005",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="99999", screen_name="testuser"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Mismatched user_id must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_timeline_rejects_completely_missing_author_data(self):
        """Timeline verification must fail-closed when author data is completely missing."""
        import datetime, email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Announcement: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="3006",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=None,
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Missing author data must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")


class TestUrlNormalizationChallenger(unittest.TestCase):
    """Rigorous tests challenging URL normalization and case sensitivity rules."""

    def test_case_sensitivity_in_url_path(self):
        """URL paths must be case-sensitive (/AbC vs /abc must NOT match)."""
        t1 = "Check out: https://example.com/AbC"
        t2 = "Check out: https://example.com/abc"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertNotEqual(
            n1, n2,
            f"Case difference in URL Path must not match: '{n1}' == '{n2}'"
        )

        p1 = "https://example.com/API/v1/ResourceData"
        p2 = "https://example.com/api/v1/resourcedata"
        self.assertNotEqual(
            normalize_text_for_comparison(p1),
            normalize_text_for_comparison(p2),
            "Multi-segment URL path differing in case must not match"
        )

    def test_case_sensitivity_in_url_query(self):
        """URL query strings must be case-sensitive (?v=XYZ vs ?v=xyz must NOT match)."""
        t1 = "Watch video: https://example.com/watch?v=XYZ"
        t2 = "Watch video: https://example.com/watch?v=xyz"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertNotEqual(
            n1, n2,
            f"Case difference in URL Query must not match: '{n1}' == '{n2}'"
        )

        q1 = "https://example.com?Token=AbCd"
        q2 = "https://example.com?token=abcd"
        self.assertNotEqual(
            normalize_text_for_comparison(q1),
            normalize_text_for_comparison(q2),
            "Query parameter names and values differing in case must not match"
        )

    def test_case_insensitivity_in_url_scheme_and_domain(self):
        """URL scheme and domain must be case-insensitive (HTTPS://EXAMPLE.COM == https://example.com)."""
        t1 = "Visit: HTTPS://EXAMPLE.COM/page"
        t2 = "Visit: https://example.com/page"
        n1 = normalize_text_for_comparison(t1)
        n2 = normalize_text_for_comparison(t2)
        self.assertEqual(
            n1, n2,
            "Scheme and domain must match regardless of uppercase/lowercase"
        )

        mixed1 = "hTtPs://SuB.ExAmPlE.CoM/Path/Doc"
        mixed2 = "https://sub.example.com/Path/Doc"
        self.assertEqual(
            normalize_text_for_comparison(mixed1),
            normalize_text_for_comparison(mixed2),
            "Mixed case scheme and domain must match canonical lowercase domain while keeping path intact"
        )

    def test_default_and_non_default_ports(self):
        """Default ports (80 for http, 443 for https) must be stripped; non-default ports like :8080 preserved."""
        https_default = "Visit: https://example.com:443/doc"
        https_clean = "Visit: https://example.com/doc"
        self.assertEqual(
            normalize_text_for_comparison(https_default),
            normalize_text_for_comparison(https_clean),
            "Port 443 must be stripped from HTTPS"
        )

        http_default = "Visit: http://example.com:80/doc"
        http_clean = "Visit: http://example.com/doc"
        self.assertEqual(
            normalize_text_for_comparison(http_default),
            normalize_text_for_comparison(http_clean),
            "Port 80 must be stripped from HTTP"
        )

        https_8080 = "Visit: https://example.com:8080/doc"
        self.assertNotEqual(
            normalize_text_for_comparison(https_8080),
            normalize_text_for_comparison(https_clean),
            "Non-default port 8080 on HTTPS must NOT match default port"
        )

        http_8080 = "Visit: http://example.com:8080/doc"
        self.assertNotEqual(
            normalize_text_for_comparison(http_8080),
            normalize_text_for_comparison(http_clean),
            "Non-default port 8080 on HTTP must NOT match default port"
        )

        self.assertNotEqual(
            normalize_text_for_comparison("https://example.com:80/doc"),
            normalize_text_for_comparison("https://example.com/doc"),
            "Port 80 is not default for HTTPS and must NOT be stripped"
        )

    def test_tco_entity_expansion_with_case_sensitive_urls(self):
        """t.co entity expansion must preserve path/query case and distinguish case differences."""
        sent_text = "Latest: https://example.com/Watch?v=AbCdEf"
        timeline_text = "Latest: https://t.co/abcXYZ"

        entities_matching = {
            "urls": [
                {
                    "url": "https://t.co/abcXYZ",
                    "expanded_url": "https://example.com/Watch?v=AbCdEf",
                    "display_url": "example.com/Watch?v=AbCdEf"
                }
            ]
        }
        self.assertEqual(
            normalize_text_for_comparison(sent_text),
            normalize_text_for_comparison(timeline_text, entities_matching),
            "t.co entity matching exact case must match sent URL"
        )

        entities_mismatched_case = {
            "urls": [
                {
                    "url": "https://t.co/abcXYZ",
                    "expanded_url": "https://example.com/watch?v=abcdef",
                    "display_url": "example.com/watch?v=abcdef"
                }
            ]
        }
        self.assertNotEqual(
            normalize_text_for_comparison(sent_text),
            normalize_text_for_comparison(timeline_text, entities_mismatched_case),
            "t.co entity with different path/query case must NOT match sent URL"
        )


class TestVerifyTimelineNegativeAuthorFencing(unittest.IsolatedAsyncioTestCase):
    """Negative tests for verify_timeline author verification."""

    async def asyncSetUp(self):
        self._sleep_patch = unittest.mock.patch("asyncio.sleep", new_callable=unittest.mock.AsyncMock)
        self._sleep_patch.start()

    async def asyncTearDown(self):
        self._sleep_patch.stop()

    async def test_graphql_tweet_without_author_data_rejected_as_ambiguous(self):
        """A GraphQL tweet with no user_id_str and no screen_name must be strictly rejected."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        gql_payload = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-2001",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "legacy": {
                                                                    "id_str": "2001",
                                                                    "full_text": sent_text,
                                                                    "created_at": now_str,
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
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Tweet lacking author data must NOT be marked found")
        self.assertEqual(res.get("status"), "ambiguous", "Tweet lacking author data must have status ambiguous")
        self.assertTrue(res.get("ambiguous"), "ambiguous flag must be True")

    async def test_graphql_tweet_with_different_author_rejected(self):
        """A GraphQL tweet with a different user_id_str or screen_name must be rejected."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        gql_payload = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-2002",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "core": {
                                                                    "user_results": {
                                                                        "result": {
                                                                            "legacy": {"screen_name": "imposter"}
                                                                        }
                                                                    }
                                                                },
                                                                "legacy": {
                                                                    "id_str": "2002",
                                                                    "full_text": sent_text,
                                                                    "created_at": now_str,
                                                                    "user_id_str": "99999",
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
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"))
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_twikit_tweet_with_different_author_rejected(self):
        """A Twikit tweet originating from a different author must be rejected."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="2003",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="99999", screen_name="imposter"),
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

    async def test_twikit_tweet_without_author_data_rejected(self):
        """A Twikit tweet with no id and no screen_name must be strictly rejected fail-closed."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="2004",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id=None, screen_name=None),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Missing all author data must fail closed")
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_mismatched_userid_with_matching_screen_name_rejected(self):
        """Tweet with matching screen_name but conflicting user.id must be rejected fail-closed."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="2005",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="99999", screen_name="testuser"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Conflicting userId must fail closed")
        self.assertEqual(res.get("status"), "ambiguous")

    async def test_mismatched_screen_name_with_matching_userid_rejected(self):
        """GraphQL tweet with matching user_id_str but conflicting screen_name must be rejected."""
        import datetime
        import email.utils
        from direct_x_bridge import DirectSession
        from types import SimpleNamespace

        sent_text = "Critical announcement text"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        gql_payload = {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": "tweet-2006",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": {
                                                                "core": {
                                                                    "user_results": {
                                                                        "result": {
                                                                            "legacy": {"screen_name": "imposter"}
                                                                        }
                                                                    }
                                                                },
                                                                "legacy": {
                                                                    "id_str": "2006",
                                                                    "full_text": sent_text,
                                                                    "created_at": now_str,
                                                                    "user_id_str": "123",
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
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "testuser", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "testuser", "userId": "123"})
        self.assertFalse(res.get("found"), "Conflicting screen_name must fail closed")
        self.assertEqual(res.get("status"), "ambiguous")


if __name__ == "__main__":
    unittest.main()

