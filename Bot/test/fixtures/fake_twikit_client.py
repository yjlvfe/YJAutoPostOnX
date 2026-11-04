"""Spec-locked Twikit & transport test doubles for hermetic Python bridge tests."""
from __future__ import annotations

import datetime
import inspect
from types import SimpleNamespace
from typing import Any

TWITTER_EPOCH_MS = 1288834974657


def make_snowflake_id(epoch_seconds: float, sequence: int = 1) -> str:
    ms = int(round(epoch_seconds * 1000.0))
    offset = max(0, ms - TWITTER_EPOCH_MS)
    snowflake = (offset << 22) | (sequence & 0xFFF)
    return str(snowflake)


class FakeUser:
    def __init__(self, user_id: str = '100001', screen_name: str = 'testuser'):
        self.id = str(user_id)
        self.screen_name = screen_name


class FakeTweet:
    def __init__(
        self,
        tweet_id: str,
        full_text: str,
        user_id: str = '100001',
        screen_name: str = 'testuser',
        created_at_epoch: float | None = None,
        entities: dict | None = None,
    ):
        self.id = str(tweet_id)
        self.full_text = full_text
        self.user = FakeUser(user_id=user_id, screen_name=screen_name)
        self.entities = entities or {'urls': []}
        self.urls = self.entities.get('urls', [])
        if created_at_epoch is not None:
            dt = datetime.datetime.fromtimestamp(created_at_epoch, tz=datetime.timezone.utc)
            self.created_at_datetime = dt
            self.created_at = dt.strftime('%a %b %d %H:%M:%S +0000 %Y')
        else:
            self.created_at_datetime = None
            self.created_at = None


class FakeV11:
    def __init__(self, user_state_val: str = 'normal', screen_name: str = 'testuser'):
        self._user_state_val = user_state_val
        self._screen_name = screen_name
        self.user_state_calls = 0
        self.settings_calls = 0
        self.user_state_side_effect: Any = None
        self.settings_side_effect: Any = None

    async def user_state(self):
        self.user_state_calls += 1
        eff = self.user_state_side_effect
        if eff is not None:
            if callable(eff):
                res = eff()
                return await res if inspect.isawaitable(res) else res
            raise eff
        return {'userState': self._user_state_val}, SimpleNamespace(status_code=200)

    async def settings(self):
        self.settings_calls += 1
        eff = self.settings_side_effect
        if eff is not None:
            if callable(eff):
                res = eff()
                return await res if inspect.isawaitable(res) else res
            raise eff
        return {'screen_name': self._screen_name}, SimpleNamespace(status_code=200)


class FakeGql:
    def __init__(self):
        self.user_tweets_calls = 0
        self.user_tweets_side_effect: Any = None
        self.user_tweets_entries: list[Any] = []

    async def user_tweets(self, user_id, count=10, cursor=None):
        self.user_tweets_calls += 1
        eff = self.user_tweets_side_effect
        if eff is not None:
            if callable(eff):
                res = eff(user_id, count, cursor)
                return await res if inspect.isawaitable(res) else res
            raise eff
        return {
            'data': {
                'user': {
                    'result': {
                        'timeline_v2': {
                            'timeline': {
                                'instructions': [
                                    {'entries': list(self.user_tweets_entries)}
                                ]
                            }
                        }
                    }
                }
            }
        }, SimpleNamespace(status_code=200)


class SpecLockedMockClient:
    """Explicitly initializes _last_* attributes to None so getattr never returns a truthy MagicMock."""

    def __init__(
        self,
        user_id: str = '100001',
        screen_name: str = 'testuser',
        user_state: str = 'normal',
    ):
        self._user_id = str(user_id)
        self._screen_name = screen_name
        self._cookies = {
            'auth_token': 'tok_1',
            'ct0': 'ct0_1',
            'twid': f'u={user_id}',
        }
        self._last_response = None
        self._last_error = None
        self._last_create_tweet_error = None
        self._last_create_tweet_response = None

        self.v11 = FakeV11(user_state_val=user_state, screen_name=screen_name)
        self.gql = FakeGql()
        self.get_user_by_id_calls = 0
        self.get_user_by_id_side_effect: Any = None
        self.create_tweet_calls = 0
        self.create_tweet_side_effect: Any = None
        self.get_user_tweets_calls = 0
        self.get_user_tweets_side_effect: Any = None
        self.timeline_tweets: list[Any] = []

    def get_cookies(self):
        return dict(self._cookies)

    def set_cookies(self, cookies, clear_cookies=False):
        if clear_cookies:
            self._cookies.clear()
        self._cookies.update(cookies)

    async def get_user_by_id(self, user_id):
        self.get_user_by_id_calls += 1
        eff = self.get_user_by_id_side_effect
        if eff is not None:
            if callable(eff):
                res = eff(user_id)
                return await res if inspect.isawaitable(res) else res
            raise eff
        return FakeUser(user_id=str(user_id), screen_name=self._screen_name)

    async def get_user_by_screen_name(self, screen_name):
        return FakeUser(user_id=self._user_id, screen_name=screen_name)

    async def create_tweet(self, text='', **kwargs):
        self.create_tweet_calls += 1
        eff = self.create_tweet_side_effect
        if eff is not None:
            if callable(eff):
                res = eff(text=text, **kwargs)
                return await res if inspect.isawaitable(res) else res
            raise eff
        import time
        now = time.time()
        tid = make_snowflake_id(now)
        return FakeTweet(
            tweet_id=tid,
            full_text=text,
            user_id=self._user_id,
            screen_name=self._screen_name,
            created_at_epoch=now,
        )

    async def get_user_tweets(self, user_id, tweet_type='Tweets', count=10):
        self.get_user_tweets_calls += 1
        eff = self.get_user_tweets_side_effect
        if eff is not None:
            if callable(eff):
                res = eff(user_id, tweet_type, count)
                return await res if inspect.isawaitable(res) else res
            raise eff
        return list(self.timeline_tweets)
