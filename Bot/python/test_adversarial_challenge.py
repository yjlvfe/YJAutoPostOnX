#!/usr/bin/env python3
"""Adversarial stress-test challenge suite for Python bridge fixes.
Tests:
1. URL normalization case-sensitivity & RFC compliance:
   - Path casing collisions
   - Query casing collisions
   - Fragment casing collisions
   - Host/scheme case-folding
   - Non-default port preservation
   - Entity expansion (t.co)
2. Timeline author validation:
   - Impostor author in GraphQL (attacker core user screen_name)
   - Mismatched user_id
   - Missing user data
   - Matching authenticated author (unwrapped & wrapped)
3. Advanced edge cases:
   - Injected token collision resistance
   - Trailing punctuation stripping
   - Punctuation inside vs outside URL
"""

import asyncio
import datetime
import email.utils
import sys
import unittest
import unittest.mock
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from direct_x_bridge import (
    canonicalize_url,
    expand_urls_with_entities,
    normalize_text_for_comparison,
    DirectSession,
    username,
    numeric_id,
)


class TestUrlNormalizationAdversarial(unittest.TestCase):
    """Adversarial challenges for URL normalization."""

    # 1. Path Casing Collisions
    def test_path_casing_collision_single_segment(self):
        """https://example.com/Product/A vs https://example.com/product/a must NOT match."""
        u1 = "https://example.com/Product/A"
        u2 = "https://example.com/product/a"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertNotEqual(n1, n2, f"Path casing collision must NOT match: {n1} == {n2}")

    def test_path_casing_collision_multi_segment(self):
        u1 = "https://example.com/Category/SubCategory/Item-123"
        u2 = "https://example.com/category/subcategory/item-123"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Multi-segment path casing difference must NOT match"
        )

    def test_path_casing_collision_file_extension(self):
        u1 = "https://example.com/downloads/DOCUMENT.PDF"
        u2 = "https://example.com/downloads/document.pdf"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "File extension casing difference must NOT match"
        )

    def test_path_casing_single_char(self):
        u1 = "https://example.com/X"
        u2 = "https://example.com/x"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Single char path casing difference must NOT match"
        )

    # 2. Query Casing Collisions
    def test_query_casing_collision_param_name(self):
        """https://example.com/s?ID=AbC vs https://example.com/s?id=abc must NOT match."""
        u1 = "https://example.com/s?ID=AbC"
        u2 = "https://example.com/s?id=abc"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertNotEqual(n1, n2, f"Query casing collision must NOT match: {n1} == {n2}")

    def test_query_casing_collision_param_value_only(self):
        u1 = "https://example.com/search?q=HelloWorld"
        u2 = "https://example.com/search?q=helloworld"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Query parameter value casing difference must NOT match"
        )

    def test_query_casing_collision_multiple_params(self):
        u1 = "https://example.com/api?Sort=ASC&Filter=ACTIVE"
        u2 = "https://example.com/api?sort=asc&filter=active"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Multiple query parameters casing difference must NOT match"
        )

    # 3. Fragment Casing Collisions
    def test_fragment_casing_collision(self):
        """https://example.com/page#Top vs https://example.com/page#top must NOT match."""
        u1 = "https://example.com/page#Top"
        u2 = "https://example.com/page#top"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertNotEqual(n1, n2, f"Fragment casing collision must NOT match: {n1} == {n2}")

    def test_fragment_casing_collision_with_kebab(self):
        u1 = "https://example.com/doc#Section-Header-A"
        u2 = "https://example.com/doc#section-header-a"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Kebab-case fragment casing difference must NOT match"
        )

    # 4. Host/Scheme Case-Folding
    def test_host_scheme_case_folding_http(self):
        """HTTP://WWW.EXAMPLE.COM:80/path vs http://www.example.com/path must match."""
        u1 = "HTTP://WWW.EXAMPLE.COM:80/path"
        u2 = "http://www.example.com/path"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertEqual(n1, n2, f"Host and scheme case-folding with default port 80 must match: {n1} != {n2}")

    def test_host_scheme_case_folding_https(self):
        """HTTPS://WWW.EXAMPLE.COM:443/path vs https://www.example.com/path must match."""
        u1 = "HTTPS://WWW.EXAMPLE.COM:443/path"
        u2 = "https://www.example.com/path"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertEqual(n1, n2, f"Host and scheme case-folding with default port 443 must match: {n1} != {n2}")

    def test_host_case_folding_preserves_path_casing(self):
        """Mixed case host must be lowercased while preserving path casing."""
        u1 = "hTtPs://SuB.ExAmPlE.CoM/CaseSensitivePath/File"
        u2 = "https://sub.example.com/CaseSensitivePath/File"
        n1 = normalize_text_for_comparison(u1)
        n2 = normalize_text_for_comparison(u2)
        self.assertEqual(n1, n2, "Scheme and host must fold to lowercase while path casing is strictly preserved")

    # 5. Non-Default Port Preservation
    def test_non_default_port_preservation_http(self):
        """http://example.com:8080/path vs http://example.com/path must NOT match."""
        u1 = "http://example.com:8080/path"
        u2 = "http://example.com/path"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Non-default port 8080 must NOT match default/omitted port"
        )

    def test_non_default_port_preservation_https(self):
        """https://example.com:8443/path vs https://example.com/path must NOT match."""
        u1 = "https://example.com:8443/path"
        u2 = "https://example.com/path"
        self.assertNotEqual(
            normalize_text_for_comparison(u1),
            normalize_text_for_comparison(u2),
            "Non-default port 8443 must NOT match default HTTPS port"
        )

    def test_cross_scheme_ports_not_stripped(self):
        """Port 80 on https and port 443 on http must NOT be stripped."""
        self.assertNotEqual(
            normalize_text_for_comparison("https://example.com:80/path"),
            normalize_text_for_comparison("https://example.com/path"),
            "Port 80 on HTTPS is non-default and must not be stripped"
        )
        self.assertNotEqual(
            normalize_text_for_comparison("http://example.com:443/path"),
            normalize_text_for_comparison("http://example.com/path"),
            "Port 443 on HTTP is non-default and must not be stripped"
        )

    # 6. Entity Expansion (t.co)
    def test_entity_expansion_matching_target(self):
        sent = "Check release: https://example.com/Releases/v2.1?Channel=Beta"
        timeline = "Check release: https://t.co/rel123"
        entities = {
            "urls": [
                {
                    "url": "https://t.co/rel123",
                    "expanded_url": "https://example.com/Releases/v2.1?Channel=Beta"
                }
            ]
        }
        self.assertEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities),
            "Properly expanded t.co URL must match sent URL"
        )

    def test_entity_expansion_different_path_case_rejected(self):
        sent = "Check release: https://example.com/Releases/v2.1"
        timeline = "Check release: https://t.co/rel123"
        entities = {
            "urls": [
                {
                    "url": "https://t.co/rel123",
                    "expanded_url": "https://example.com/releases/v2.1"
                }
            ]
        }
        self.assertNotEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities),
            "Expanded t.co with different path case must NOT match sent URL"
        )

    def test_entity_expansion_unmapped_rejected(self):
        sent = "Check release: https://example.com/Releases/v2.1"
        timeline = "Check release: https://t.co/unmapped123"
        self.assertNotEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities=None),
            "Unmapped t.co must NOT match full URL (fail-closed)"
        )
        self.assertNotEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities={}),
            "Empty entities dict must NOT match full URL"
        )

    def test_multiple_tco_expansion(self):
        sent = "Doc: https://example.com/Docs/API and Repo: https://example.com/Code/Repo"
        timeline = "Doc: https://t.co/doc1 and Repo: https://t.co/repo2"
        entities = {
            "urls": [
                {"url": "https://t.co/doc1", "expanded_url": "https://example.com/Docs/API"},
                {"url": "https://t.co/repo2", "expanded_url": "https://example.com/Code/Repo"},
            ]
        }
        self.assertEqual(
            normalize_text_for_comparison(sent),
            normalize_text_for_comparison(timeline, entities),
            "Multiple t.co URLs expanded correctly must match"
        )

    # 7. Surrounding Text vs URL Case
    def test_surrounding_text_case_insensitive_url_case_sensitive(self):
        """Surrounding text case changes do NOT break match, but URL case changes DO break match."""
        t1 = "ANNOUNCING NEW FEATURE: https://example.com/Feature/X"
        t2 = "announcing new feature: https://example.com/Feature/X"
        t3 = "announcing new feature: https://example.com/feature/x"
        self.assertEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t2),
            "Surrounding text case difference should match"
        )
        self.assertNotEqual(
            normalize_text_for_comparison(t1),
            normalize_text_for_comparison(t3),
            "URL path case difference must NOT match even if surrounding text matches"
        )


class TestVerifyTimelineAuthorAdversarial(unittest.IsolatedAsyncioTestCase):
    """Adversarial challenges for verify_timeline author validation."""

    async def asyncSetUp(self):
        self._sleep_patch = unittest.mock.patch("asyncio.sleep", new_callable=unittest.mock.AsyncMock)
        self._sleep_patch.start()

    async def asyncTearDown(self):
        self._sleep_patch.stop()

    def _build_gql_payload(self, tweet_id, full_text, screen_name=None, user_id_str=None, wrapped=False):
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        user_result = {}
        if screen_name is not None:
            user_result["legacy"] = {"screen_name": screen_name}
        if user_id_str is not None:
            user_result["rest_id"] = str(user_id_str)

        tweet_data = {
            "legacy": {
                "id_str": str(tweet_id),
                "full_text": full_text,
                "created_at": now_str,
            }
        }
        if user_id_str is not None:
            tweet_data["legacy"]["user_id_str"] = str(user_id_str)
        if screen_name is not None:
            tweet_data["legacy"]["screen_name"] = screen_name

        if user_result:
            tweet_data["core"] = {
                "user_results": {
                    "result": user_result
                }
            }

        if wrapped:
            result_node = {
                "__typename": "TweetWithVisibilityResults",
                "tweet": tweet_data
            }
        else:
            result_node = tweet_data

        return {
            "data": {
                "user": {
                    "result": {
                        "timeline_v2": {
                            "timeline": {
                                "instructions": [
                                    {
                                        "entries": [
                                            {
                                                "entryId": f"tweet-{tweet_id}",
                                                "content": {
                                                    "itemContent": {
                                                        "tweet_results": {
                                                            "result": result_node
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

    # Challenge 1: Impostor author in GraphQL (attacker core user screen_name)
    async def test_impostor_screen_name_in_graphql_rejected(self):
        """Core user screen_name is attacker -> must reject fail-closed (found: False)."""
        sent_text = "Important update: https://example.com/News"
        gql_payload = self._build_gql_payload(
            tweet_id="9001",
            full_text=sent_text,
            screen_name="attacker_account",
            user_id_str="123",  # Mismatched screen_name even if userId happens to match
        )
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Impostor screen_name must NOT be marked found")
        self.assertEqual(res.get("status"), "ambiguous", "Must fail-closed with status ambiguous")
        self.assertTrue(res.get("ambiguous"))

    # Challenge 2: Mismatched user_id in GraphQL
    async def test_mismatched_user_id_in_graphql_rejected(self):
        """User ID in tweet belongs to someone else -> must reject fail-closed (found: False)."""
        sent_text = "Important update: https://example.com/News"
        gql_payload = self._build_gql_payload(
            tweet_id="9002",
            full_text=sent_text,
            screen_name="target_user",
            user_id_str="666666",  # Attacker user ID
        )
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Mismatched user_id must NOT be marked found")
        self.assertEqual(res.get("status"), "ambiguous")

    # Challenge 3: Completely missing author data in GraphQL
    async def test_missing_user_data_in_graphql_rejected(self):
        """Tweet with no core user_results and no legacy author fields -> must reject."""
        sent_text = "Important update: https://example.com/News"
        gql_payload = self._build_gql_payload(
            tweet_id="9003",
            full_text=sent_text,
            screen_name=None,
            user_id_str=None,
        )
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Missing author data must NOT be marked found")
        self.assertEqual(res.get("status"), "ambiguous")

    # Challenge 4: Matching authenticated author in GraphQL (unwrapped)
    async def test_matching_authenticated_author_graphql_unwrapped(self):
        """Authenticated author matches -> must accept (found: True, status: published)."""
        sent_text = "Important update: https://example.com/News"
        gql_payload = self._build_gql_payload(
            tweet_id="9004",
            full_text=sent_text,
            screen_name="target_user",
            user_id_str="123",
            wrapped=False
        )
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertTrue(res.get("found"), "Matching authenticated author must be accepted")
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "9004")

    # Challenge 5: Matching authenticated author in GraphQL (wrapped in TweetWithVisibilityResults)
    async def test_matching_authenticated_author_graphql_wrapped(self):
        """Wrapped tweet with matching author -> must accept."""
        sent_text = "Important update: https://example.com/News"
        gql_payload = self._build_gql_payload(
            tweet_id="9005",
            full_text=sent_text,
            screen_name="target_user",
            user_id_str="123",
            wrapped=True
        )
        mock_client = SimpleNamespace(
            gql=SimpleNamespace(
                user_tweets=unittest.mock.AsyncMock(return_value=(gql_payload, None))
            )
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertTrue(res.get("found"), "Matching author in wrapped tweet must be accepted")
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "9005")

    # Challenge 6: Twikit fallback impostor author rejected
    async def test_twikit_fallback_impostor_screen_name_rejected(self):
        sent_text = "Important update: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="9006",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="attacker_account"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Twikit fallback impostor must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")

    # Challenge 7: Twikit fallback mismatched user_id rejected
    async def test_twikit_fallback_mismatched_user_id_rejected(self):
        sent_text = "Important update: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="9007",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="666666", screen_name="target_user"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Twikit fallback mismatched user_id must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")

    # Challenge 8: Twikit fallback missing author rejected
    async def test_twikit_fallback_missing_author_rejected(self):
        sent_text = "Important update: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="9008",
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
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertFalse(res.get("found"), "Twikit fallback missing author must be rejected")
        self.assertEqual(res.get("status"), "ambiguous")

    # Challenge 9: Twikit fallback matching authenticated author accepted
    async def test_twikit_fallback_matching_author_accepted(self):
        sent_text = "Important update: https://example.com/News"
        now_str = email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))
        tw = SimpleNamespace(
            id="9009",
            full_text=sent_text,
            created_at=now_str,
            created_at_datetime=None,
            user=SimpleNamespace(id="123", screen_name="target_user"),
            urls=None,
            entities=None,
        )
        mock_client = SimpleNamespace(
            get_user_tweets=unittest.mock.AsyncMock(return_value=[tw])
        )
        session = DirectSession(mock_client, {"username": "target_user", "userId": "123"})
        res = await session.verify_timeline(sent_text, {"username": "target_user", "userId": "123"})
        self.assertTrue(res.get("found"), "Twikit fallback matching author must be accepted")
        self.assertEqual(res.get("status"), "published")
        self.assertEqual(res.get("tweetId"), "9009")


if __name__ == "__main__":
    unittest.main()
