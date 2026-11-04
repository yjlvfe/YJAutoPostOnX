"""Per-client Twikit compatibility without process-global monkey-patching.

The direct-X bridge obtains its Client, transaction and User subclasses from
``compatibility_client``. Third-party Twikit classes remain unchanged for every
other client in the interpreter.
"""
from __future__ import annotations

from importlib.metadata import version
import re
from urllib.parse import urlsplit


async def _transaction_indices(home_page_response, session, headers):
    text = str(home_page_response)
    chunk = re.search(r'[,{}](\d+):["\']ondemand\.s["\']', text)
    digest = None
    if chunk:
        match = re.search(r'[,{}]' + chunk[1] + r':["\']([0-9a-f]+)["\']', text)
        if match:
            digest = match[1]
    if not digest:
        match = re.search(r'["\']ondemand\.s["\']\s*:\s*["\']([\w]+)["\']', text)
        if match:
            digest = match[1]
    if digest:
        response = await session.request(
            'GET',
            f'https://abs.twimg.com/responsive-web/client-web/ondemand.s.{digest}a.js',
            headers=headers,
        )
        response.raise_for_status()
        values = re.findall(r'\[(\d+)\],\s*16', response.text)
        if len(values) > 1:
            return int(values[0]), [int(value) for value in values[1:]]
    raise ValueError('transaction_manifest_unavailable')


_BANNED_PATTERN = re.compile(
    r'\b(?:account|user)\s+(?:has\s+been\s+|is\s+)?suspended\b|\baccount\s+suspended\b',
    re.IGNORECASE,
)

_CAPTCHA_KEYWORDS = (
    'captcha', 'arkose', 'funcaptcha', 'verification_required',
    'verification required', 'challenge_required', 'challenge required',
    'temporarily locked', 'unlock your account', 'account/access',
    'login_verification', 'user is locked', 'account is locked'
)

_COOKIE_EXPIRED_KEYWORDS = (
    'token is expired', 'session expired', 'expired token',
    'cookie expired', 'cookies expired', 'session invalidated',
    'invalid session', 'invalid or expired token'
)

_AUTH_REJECTED_KEYWORDS = (
    'bad authentication data', 'could not authenticate you',
    'auth rejected', 'authentication failed', 'unauthorized',
    'incorrect password', 'account compromised', 'unable to verify credentials'
)

_RATE_LIMIT_KEYWORDS = (
    'rate limit', 'rate_limit', 'too many requests',
    'over capacity', 'over daily status update limit',
    'exceeded rate limit', 'user is over daily status update limit'
)

_NETWORK_PROXY_KEYWORDS = (
    'proxy', 'socks', 'socks5', 'connection refused', 'connection reset',
    'connection error', 'connecterror', 'timed out', 'timeout',
    'network unreachable', 'host unreachable', 'name resolution failure',
    'getaddrinfo failed', 'ssl error', 'remote protocol error', 'network error',
    'econnrefused', 'econnreset', 'etimedout', 'connect timeout', 'read timeout',
    'socket timeout', 'pool timeout', 'broken pipe', 'connection abort',
    'temporary failure in name resolution'
)

_AMBIGUOUS_KEYWORDS = (
    'ambiguous', 'unconfirmed', 'publish_confirmation_missing',
    'dispatch_already_attempted', 'eventual consistency'
)


def _compat_user_data(data):
    """Normalize and patch GraphQL user data so legacy entities (description.urls, url.urls, etc.)
    never raise KeyError: 'urls' or AttributeError on None.
    Handles root, wrapped, or nested user representations.
    """
    if not isinstance(data, dict):
        return data
    result = dict(data)
    if 'result' in result and isinstance(result['result'], dict):
        result['result'] = _compat_user_data(result['result'])
    if 'user' in result and isinstance(result['user'], dict):
        result['user'] = _compat_user_data(result['user'])

    legacy = result.get('legacy')
    if isinstance(legacy, dict):
        legacy = dict(legacy)
        entities = legacy.get('entities')
        if not isinstance(entities, dict):
            entities = {}
        else:
            entities = dict(entities)

        description = entities.get('description')
        if not isinstance(description, dict):
            description = {'urls': []}
        else:
            description = dict(description)
            if not isinstance(description.get('urls'), list):
                description['urls'] = []
        entities['description'] = description

        url_obj = entities.get('url')
        if not isinstance(url_obj, dict):
            url_obj = {'urls': []}
        else:
            url_obj = dict(url_obj)
            if not isinstance(url_obj.get('urls'), list):
                url_obj['urls'] = []
        entities['url'] = url_obj

        legacy['entities'] = entities
        if not isinstance(legacy.get('pinned_tweet_ids_str'), list):
            legacy['pinned_tweet_ids_str'] = []
        if not isinstance(legacy.get('withheld_in_countries'), list):
            legacy['withheld_in_countries'] = []
        result['legacy'] = legacy
    return result


def classify_x_account_failure(raw_json=None, errors=None, text='', http_status=None):
    """
    Inspect X responses/errors and classify failure into one of 8 granular categories:
      'banned'              -> Permanent suspension (64, 63, 141, suspended)
      'captcha'             -> Verification/Arkose/Lock challenge (326, 353, 399, 241, bounce_location, captcha, challenge)
      'cookie_expired'      -> Expired/invalid session cookies (89, token is expired, session expired)
      'auth_rejected'       -> Rejected credentials / unauthorized (32, 135, 215, 99, 231, bad auth)
      'rate_limit'          -> API rate limit or status limit exceeded (88, 185, HTTP 429)
      'network_proxy_error' -> Proxy, SOCKS5, DNS, connection reset/timeout errors
      'ambiguous'           -> Unconfirmed dispatch, eventual consistency, or outcome unknown
      'unknown'             -> Unclassified account failure with explicit error present
      None                  -> No account failure detected
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
        if isinstance(raw_json.get('reason'), str):
            reason_str = raw_json['reason'].strip().lower()
            if reason_str == 'suspended':
                return 'banned'
            messages.append(raw_json['reason'])

    for e in errors:
        if isinstance(e, dict):
            if type(e.get('code')) is int:
                codes.add(e['code'])
            ext = e.get('extensions')
            ext_code = ext.get('code') if isinstance(ext, dict) else None
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

    if codes & {64, 63, 141}:
        return 'banned'

    if (codes & {326, 353, 399, 241}) or has_bounce or any(w in combined for w in _CAPTCHA_KEYWORDS):
        return 'captcha'

    if (codes & {88, 185}) or http_status == 429 or any(w in combined for w in _RATE_LIMIT_KEYWORDS):
        return 'rate_limit'

    if (codes & {89}) or any(w in combined for w in _COOKIE_EXPIRED_KEYWORDS):
        return 'cookie_expired'

    if (codes & {32, 135, 215, 99, 231}) or any(w in combined for w in _AUTH_REJECTED_KEYWORDS):
        return 'auth_rejected'

    # Network / proxy / timeout errors MUST strictly return network_proxy_error
    # and NEVER banned, even if proxy error messages reference suspended account endpoints.
    if any(w in combined for w in _NETWORK_PROXY_KEYWORDS):
        return 'network_proxy_error'

    if bool(_BANNED_PATTERN.search(combined)):
        return 'banned'

    if any(w in combined for w in _AMBIGUOUS_KEYWORDS):
        return 'ambiguous'

    if 'auth_session_unverified' in combined or 'session_unverified' in combined or 'state_unverified' in combined:
        return 'auth_session_unverified'

    if 'unknown' in combined or 'unspecified' in combined:
        return 'unknown'

    return None


def classify_x_tweet_rejection(raw_json=None, errors=None, text='', http_status=None):
    """
    Granularly classify tweet content or policy rejections from X:
      'duplicate_content'  -> Code 187, "Status is a duplicate", "already posted"
      'length_exceeded'    -> Code 186, "Tweet needs to be a bit shorter", "character limit"
      'content_moderation' -> Code 226, automated or spam flags
      'account_locked'     -> Code 326, 353, 399, 241
      'account_suspended'  -> Code 64, 63, 141
      'auth_rejected'      -> Code 32, 135, 215, 99, 231
      'rate_limit'         -> Code 88, 185, HTTP 429
      'tweet_tombstone'    -> TweetTombstone in GraphQL response
      None                 -> Not a recognized content/policy rejection
    """
    if isinstance(raw_json, dict) and not errors:
        errors = raw_json.get('errors', [])
    errors = errors if isinstance(errors, list) else []

    codes = set()
    messages = []

    if isinstance(raw_json, dict):
        if isinstance(raw_json.get('message'), str):
            messages.append(raw_json['message'])
        res_data = raw_json.get('data', {}).get('create_tweet', {}).get('tweet_results', {}).get('result', {})
        if isinstance(res_data, dict) and res_data.get('__typename') == 'TweetTombstone':
            return 'tweet_tombstone'

    for e in errors:
        if isinstance(e, dict):
            if type(e.get('code')) is int:
                codes.add(e['code'])
            ext = e.get('extensions')
            ext_code = ext.get('code') if isinstance(ext, dict) else None
            if type(ext_code) is int:
                codes.add(ext_code)
            msg = e.get('message')
            if isinstance(msg, str):
                messages.append(msg)

    if text and isinstance(text, str):
        messages.append(text)

    combined = ' '.join(messages).lower()

    if 187 in codes or 'duplicate' in combined:
        return 'duplicate_content'

    if 186 in codes or 'shorter' in combined or 'too long' in combined or 'character limit' in combined:
        return 'length_exceeded'

    if 226 in codes or 'automated' in combined or 'spam' in combined:
        return 'content_moderation'

    if codes & {326, 353, 399, 241}:
        return 'account_locked'

    if codes & {64, 63, 141}:
        return 'account_suspended'

    if codes & {32, 135, 215, 99, 231}:
        return 'auth_rejected'

    if (codes & {88, 185}) or http_status == 429:
        return 'rate_limit'

    if 'tweettombstone' in combined:
        return 'tweet_tombstone'

    return None



def _x_error_with_details(exc, payload=None, http_status=None):
    """Preserve X codes/messages on ALL exception paths, without printing raw JSON."""
    body = payload if isinstance(payload, dict) else {}
    errors = body.get('errors') if isinstance(body.get('errors'), list) else []
    first = next((entry for entry in errors if isinstance(entry, dict)), {})
    extensions = first.get('extensions')
    extensions = extensions if isinstance(extensions, dict) else {}
    code = first.get('code')
    if code is None:
        code = extensions.get('code')
    if isinstance(code, (dict, list, bool)):
        code = None
    if code is not None and not isinstance(code, (str, int)):
        code = None
    message = first.get('message')
    message = message[:512] if isinstance(message, str) else None

    exc.raw_json = body  # internal classification only: never dump full payload to logs
    exc.errors = errors
    exc.code = code
    exc.error_code = code
    exc.x_error_message = message
    exc.x_response_kind = 'graphql_errors' if errors else 'http_or_transport_failure'
    if http_status is not None:
        exc.http_status = http_status
    return exc

def compatibility_client():
    """Build a local Client subclass; never rewrite third-party classes/methods."""
    validate_versions()
    from twikit.client.client import Client
    from twikit.errors import (
        CouldNotTweet, TwitterException, UserNotFound, UserUnavailable,
        raise_exceptions_from_response,
    )
    from twikit.tweet import Tweet
    from twikit.user import User
    from twikit.x_client_transaction.transaction import ClientTransaction  # type: ignore
    from twikit.utils import find_dict  # type: ignore

    # Monkeypatch twikit.user.User.__init__ so any User instantiated anywhere in twikit
    # (e.g. inside twikit.tweet.tweet_from_data, get_user_tweets, search_tweet, etc.)
    # automatically normalizes data through _compat_user_data to prevent KeyError: 'urls'.
    _orig_user_init = User.__init__
    if not getattr(User, '_compat_patched', False):
        def _safe_user_init(self, client, data):
            _orig_user_init(self, client, _compat_user_data(data))
        User.__init__ = _safe_user_init
        User._compat_patched = True

    class DirectUser(User):
        def __init__(self, client, data):
            super().__init__(client, _compat_user_data(data))

    class DirectTransaction(ClientTransaction):
        # Inherit init and key generation; only the manifest lookup differs.
        async def get_indices(self, home_page_response, session, headers):
            return await _transaction_indices(home_page_response, session, headers)

    def direct_tweet_from_data(client, data):
        tweet_data_ = find_dict(data, 'result', True)
        if not tweet_data_:
            return None
        tweet_data = tweet_data_[0]
        if tweet_data.get('__typename') == 'TweetTombstone':
            return None
        if 'tweet' in tweet_data:
            tweet_data = tweet_data['tweet']
        if 'core' not in tweet_data:
            return None
        if 'result' not in tweet_data['core']['user_results']:
            return None
        if 'legacy' not in tweet_data:
            return None
        user_data = tweet_data['core']['user_results']['result']
        return Tweet(client, tweet_data, DirectUser(client, user_data))

    class CompatibilityClient(Client):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            self.client_transaction = DirectTransaction()

        async def request(self, method, url, auto_unlock=False, raise_exception=True, **kwargs):
            """One non-retrying request; never unlock or replay a write."""
            headers = dict(kwargs.pop('headers', {}))
            if 'x.com' in url or 'twitter.com' in url:
                headers.setdefault('Accept', '*/*')
                headers.setdefault('Accept-Language', self.language or 'en-US,en;q=0.9')
                headers.setdefault('sec-ch-ua', '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"')
                headers.setdefault('sec-ch-ua-mobile', '?0')
                headers.setdefault('sec-ch-ua-platform', '"Windows"')
                headers.setdefault('Sec-Fetch-Dest', 'empty')
                headers.setdefault('Sec-Fetch-Mode', 'cors')
                headers.setdefault('Sec-Fetch-Site', 'same-origin')
                if 'CreateTweet' in url:
                    headers['Referer'] = 'https://x.com/compose/post'
            if not self.client_transaction.home_page_response:
                cookies = self.get_cookies().copy()
                try:
                    await self.client_transaction.init(self.http, {
                        'Accept-Language': self.language,
                        'Cache-Control': 'no-cache',
                        'Referer': 'https://x.com',
                        'User-Agent': self._user_agent,
                    })
                except Exception:
                    self.client_transaction.degraded = True
                    self.client_transaction.home_page_response = True
                finally:
                    self.set_cookies(cookies, clear_cookies=True)
            if not getattr(self.client_transaction, 'degraded', False):
                try:
                    tid = self.client_transaction.generate_transaction_id(
                        method=method, path=urlsplit(url).path,
                    )
                    if tid:
                        headers['X-Client-Transaction-Id'] = tid
                except Exception:
                    pass
            response = await self.http.request(method, url, headers=headers, **kwargs)
            self._remove_duplicate_ct0_cookie()
            raw_json = {}
            try:
                raw_json = response.json()
            except (ValueError, AttributeError):
                raw_json = {}
            errors = raw_json.get('errors', []) if isinstance(raw_json, dict) else []
            errors = errors if isinstance(errors, list) else []
            failure = classify_x_account_failure(raw_json=raw_json, errors=errors)
            if failure:
                error = _x_error_with_details(
                    TwitterException('direct_x_account_failure'),
                    raw_json, response.status_code
                )
                error.account_failure = failure
                if failure == 'rate_limit':
                    error.retry_after_seconds = 60
                raise error
            if response.status_code >= 300:
                error = _x_error_with_details(
                    TwitterException('direct_x_http_failure'),
                    raw_json, response.status_code
                )
                if response.status_code == 429:
                    error.account_failure = 'rate_limit'
                    import time
                    try:
                        seconds = float(response.headers.get('retry-after', '0'))
                        reset = float(response.headers.get('x-rate-limit-reset', '0')) - time.time()
                        error.retry_after_seconds = min(900, max(60, seconds, reset))
                    except (ValueError, TypeError):
                        error.retry_after_seconds = 60
                raise error
            try:
                data = response.json()
            except ValueError:
                raise TwitterException('direct_x_invalid_json') from None
            if isinstance(data, dict) and data.get('errors'):
                first_err = next((e for e in data['errors'] if isinstance(e, dict)), {})
                extensions = first_err.get('extensions') if isinstance(first_err.get('extensions'), dict) else {}
                err_code = first_err.get('code')
                if err_code is None:
                    err_code = extensions.get('code')
                err_msg = str(first_err.get('message') or 'direct_x_api_failure')[:512]
                error = _x_error_with_details(
                    TwitterException(f'direct_x_api_failure: [{err_code}] {err_msg}'),
                    data, response.status_code
                )
                failure = classify_x_account_failure(raw_json=data, errors=data['errors'])
                if failure:
                    error.account_failure = failure
                raise error
            return data, response

        async def get_user_by_id(self, user_id):
            response, _ = await self.gql.user_by_rest_id(user_id)
            if not isinstance(response, dict) or 'data' not in response or 'user' not in response['data']:
                raise UserNotFound('The user does not exist.')
            user_data = response.get('data', {}).get('user', {}).get('result', {})
            if user_data.get('__typename') == 'UserUnavailable':
                msg = str(user_data.get('message', ''))
                reason = str(user_data.get('reason', ''))
                error = UserUnavailable(msg or reason or 'UserUnavailable')
                failure = classify_x_account_failure(raw_json=user_data, text=msg or reason)
                if not failure and (reason.lower() == 'suspended' or 'suspended' in msg.lower()):
                    failure = 'banned'
                if failure:
                    error.account_failure = failure
                raise error
            return DirectUser(self, user_data)

        async def get_user_by_screen_name(self, screen_name):
            response, _ = await self.gql.user_by_screen_name(screen_name)
            if 'user' not in response['data']:
                raise UserNotFound('The user does not exist.')
            user_data = response['data']['user']['result']
            if user_data.get('__typename') == 'UserUnavailable':
                msg = str(user_data.get('message', ''))
                reason = str(user_data.get('reason', ''))
                error = UserUnavailable(msg or reason or 'UserUnavailable')
                failure = classify_x_account_failure(raw_json=user_data, text=msg or reason)
                if not failure and (reason.lower() == 'suspended' or 'suspended' in msg.lower()):
                    failure = 'banned'
                if failure:
                    error.account_failure = failure
                raise error
            return DirectUser(self, user_data)

        async def create_tweet(
            self, text='', media_ids=None, poll_uri=None, reply_to=None,
            conversation_control=None, attachment_url=None, community_id=None,
            share_with_followers=False, is_note_tweet=False,
            richtext_options=None, edit_tweet_id=None,
        ):
            media_entities = [
                {'media_id': media_id, 'tagged_users': []}
                for media_id in (media_ids or [])
            ]
            limit_mode = None
            if conversation_control is not None:
                conversation_control = conversation_control.lower()
                limit_mode = {
                    'followers': 'Community',
                    'verified': 'Verified',
                    'mentioned': 'ByInvitation',
                }[conversation_control]
            response, _ = await self.gql.create_tweet(
                is_note_tweet, text, media_entities, poll_uri, reply_to,
                attachment_url, community_id, share_with_followers,
                richtext_options, edit_tweet_id, limit_mode,
            )
            self._last_create_tweet_response = response
            if isinstance(response, dict) and response.get('errors'):
                failure = classify_x_account_failure(raw_json=response, errors=response.get('errors', []))
                if failure:
                    error = _x_error_with_details(
                        TwitterException('direct_x_account_failure'), response
                    )
                    error.account_failure = failure
                    if failure == 'rate_limit':
                        error.http_status = 429
                        error.retry_after_seconds = 60
                    raise error
                try:
                    raise_exceptions_from_response(response['errors'])
                except Exception as exc:
                    # Retain Twikit's specific exception type, but never lose
                    # the original GraphQL error code/message during mapping.
                    raise _x_error_with_details(exc, response) from None
                raise _x_error_with_details(CouldNotTweet('Failed to post a tweet.'), response)
            if is_note_tweet:
                result = response['data']['notetweet_create']['tweet_results']
            else:
                result = response['data']['create_tweet']['tweet_results']
            return direct_tweet_from_data(self, result)

    return CompatibilityClient


def validate_versions():
    required = {
        'twikit': '2.3.3',
        'curl_cffi': '0.17.0',
        'httpx': '0.28.1',
        'httpcore': '1.0.9',
        'socksio': '1.0.0',
    }
    if any(version(package) != pinned for package, pinned in required.items()):
        raise RuntimeError('direct_x_dependency_version_mismatch')

