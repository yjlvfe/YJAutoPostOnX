"""Twikit compatibility layer for the isolated Direct-X bridge process.

The direct-X bridge obtains its ``CompatibilityClient``, ``DirectTransaction``,
and ``DirectUser`` classes from ``compatibility_client()``. Because Twikit's own
internal helpers (e.g. ``twikit.tweet.tweet_from_data``) instantiate
``twikit.user.User`` directly rather than through a client factory method,
``compatibility_client()`` also installs an idempotent, process-scoped
normalization wrapper on ``twikit.user.User.__init__`` (via ``_compat_user_data``)
so missing ``legacy.entities.description.urls`` or ``legacy.entities.url.urls``
fields never raise ``KeyError: 'urls'`` inside the isolated single-account bridge.
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
    'proxy', 'socks', 'socks5', 'socksio', 'curl', 'connection refused', 'connection reset',
    'connection error', 'connecterror', 'timed out', 'timeout',
    'network unreachable', 'host unreachable', 'name resolution failure',
    'getaddrinfo failed', 'ssl error', 'ssl protocol', 'remote protocol error', 'network error',
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
            # Free-text reason/message fields are not authoritative owner state.
            # Keep them for non-destructive diagnostics, but never ban from text.
            messages.append(raw_json['reason'])

    for e in errors:
        if isinstance(e, dict):
            if str(e.get('code', '')).isdigit():
                codes.add(int(e['code']))
            ext = e.get('extensions')
            ext_code = ext.get('code') if isinstance(ext, dict) else None
            if str(ext_code or '').isdigit():
                codes.add(int(ext_code))
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

    if (codes & {326, 353, 399, 241}) or has_bounce:
        return 'captcha'

    if (codes & {88, 185, 344}) or http_status == 429:
        return 'rate_limit'

    if codes & {89}:
        return 'cookie_expired'

    if codes & {32, 135, 215, 99, 231}:
        return 'auth_rejected'

    # Network / proxy / timeout errors MUST strictly return network_proxy_error
    # BEFORE fallback keyword matching so curl/socksio/proxy error strings mentioning
    # captcha, rate limit, expired tokens or credentials never misclassify transport failures.
    if any(w in combined for w in _NETWORK_PROXY_KEYWORDS):
        return 'network_proxy_error'

    if any(w in combined for w in _CAPTCHA_KEYWORDS):
        return 'captcha'

    if any(w in combined for w in _RATE_LIMIT_KEYWORDS):
        return 'rate_limit'

    if any(w in combined for w in _COOKIE_EXPIRED_KEYWORDS):
        return 'cookie_expired'

    if any(w in combined for w in _AUTH_REJECTED_KEYWORDS):
        return 'auth_rejected'

    # Suspension text is untrusted: it may describe a public target, a quoted
    # message, or a negated/third-party condition. Permanent owner state is
    # accepted only through authoritative numeric error codes above.

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
        data = raw_json.get('data')
        node = (data.get('create_tweet') or data.get('notetweet_create')) if isinstance(data, dict) else None
        results = node.get('tweet_results') if isinstance(node, dict) else None
        res_data = results.get('result') if isinstance(results, dict) else None
        if isinstance(res_data, dict) and res_data.get('__typename') == 'TweetTombstone':
            return 'tweet_tombstone'

    for e in errors:
        if isinstance(e, dict):
            if str(e.get('code', '')).isdigit():
                codes.add(int(e['code']))
            ext = e.get('extensions')
            ext_code = ext.get('code') if isinstance(ext, dict) else None
            if str(ext_code or '').isdigit():
                codes.add(int(ext_code))
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

    if (codes & {88, 185, 344}) or http_status == 429:
        return 'rate_limit'

    if 'tweettombstone' in combined:
        return 'tweet_tombstone'

    return None



_SECRET_BEARER_RE = re.compile(r'Bearer\s+[A-Za-z0-9_\-\.~+/]+=*', re.IGNORECASE)
_SECRET_KV_RE = re.compile(
    r'\b(auth_token|ct0|twid|kdt|password|secret|api[_-]?key|access[_-]?token|authorization|cookie)'
    r'(\s*[=:]\s*["\']?)([^\s,;&"\'\r\n]+)',
    re.IGNORECASE,
)
_SECRET_JSON_RE = re.compile(
    r'(["\'])(auth_token|ct0|twid|kdt|password|secret|api[_-]?key|access[_-]?token|authorization|cookie)\1'
    r'(\s*:\s*["\'])([^"\']*)(["\'])',
    re.IGNORECASE,
)


def _scrub_secret_text(value, max_len=512):
    if not isinstance(value, str):
        return None
    text = _SECRET_BEARER_RE.sub('Bearer [REDACTED]', value)
    text = _SECRET_JSON_RE.sub(r'\1\2\1\3[REDACTED]\5', text)
    text = _SECRET_KV_RE.sub(r'\1\2[REDACTED]', text)
    return text[:max_len]


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
    message = _scrub_secret_text(message, 512) if isinstance(message, str) else None

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
    """Build the CompatibilityClient subclass and install idempotent User.__init__ normalization."""
    validate_versions()
    from twikit.client.client import Client
    from twikit.client.v11 import V11Client  # type: ignore
    from twikit.errors import (
        CouldNotTweet, TwitterException, UserNotFound, UserUnavailable,
        raise_exceptions_from_response,
    )
    from twikit.tweet import Tweet
    from twikit.user import User
    from twikit.x_client_transaction.transaction import ClientTransaction  # type: ignore

    # Idempotently wrap twikit.user.User.__init__ in this isolated bridge process
    # so any User instantiated inside twikit (e.g. tweet_from_data, get_user_tweets,
    # search_tweet) normalizes data through _compat_user_data to prevent KeyError: 'urls'.
    _orig_user_init = User.__init__
    if not getattr(User, '_compat_patched', False):
        def _safe_user_init(self, client, data):
            _orig_user_init(self, client, _compat_user_data(data))
        User.__init__ = _safe_user_init
        User._compat_patched = True
        User._yj_safe_urls_patched = True

    class CompatibilityV11Client(V11Client):
        async def verify_credentials(self, skip_status: bool = True, include_entities: bool = False):
            query_parts = []
            if skip_status:
                query_parts.append('skip_status=true')
            if not include_entities:
                query_parts.append('include_entities=false')
            query = f"?{'&'.join(query_parts)}" if query_parts else ''
            url = f'https://api.x.com/1.1/account/verify_credentials.json{query}'
            return await self.base.get(url, headers=getattr(self.base, '_base_headers', None))

    class DirectUser(User):
        def __init__(self, client, data):
            super().__init__(client, _compat_user_data(data))

    class DirectTransaction(ClientTransaction):
        # Inherit init and key generation; only the manifest lookup differs.
        async def get_indices(self, home_page_response, session, headers):
            return await _transaction_indices(home_page_response, session, headers)

    def direct_tweet_from_data(client, data):
        if not isinstance(data, dict):
            return None
        try:
            tweet_data = data.get('result', data)
            if not isinstance(tweet_data, dict) or tweet_data.get('__typename') in ('TweetTombstone', 'TweetUnavailable'):
                return None
            if isinstance(tweet_data.get('tweet'), dict):
                tweet_data = tweet_data['tweet']
            if tweet_data.get('__typename') in ('TweetTombstone', 'TweetUnavailable'):
                return None
            legacy = tweet_data.get('legacy')
            if not isinstance(legacy, dict):
                return None
            tid = tweet_data.get('rest_id') or legacy.get('id_str')
            if not isinstance(tid, str) or not tid.isdigit():
                return None
            tweet_data = dict(tweet_data, rest_id=tid)
            core = tweet_data.get('core')
            users = core.get('user_results') if isinstance(core, dict) else None
            user_data = users.get('result') if isinstance(users, dict) else None
            if isinstance(user_data, dict) and isinstance(user_data.get('user'), dict):
                user_data = user_data['user']
            if not isinstance(user_data, dict):
                return None
            return Tweet(client, tweet_data, DirectUser(client, user_data))
        except (AttributeError, KeyError, TypeError):
            return None

    # Preserve valid TweetWithVisibilityResults while failing closed on partial data.

    class CompatibilityClient(Client):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            self.client_transaction = DirectTransaction()
            self.v11 = CompatibilityV11Client(self)

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
            if 'CreateTweet' in str(url) or 'CreateNoteTweet' in str(url):
                self._last_create_tweet_http_status = response.status_code
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
                    import time
                    try:
                        headers = getattr(response, 'headers', None) or {}
                        seconds = float(headers.get('retry-after') or headers.get('Retry-After') or '0')
                        reset_val = headers.get('x-rate-limit-reset') or headers.get('X-Rate-Limit-Reset') or '0'
                        reset = float(reset_val) - time.time()
                        error.retry_after_seconds = min(900, max(60, seconds, reset))
                    except (ValueError, TypeError):
                        error.retry_after_seconds = 60
                raise error
            if response.status_code >= 300 and raise_exception:
                error = _x_error_with_details(
                    TwitterException('direct_x_http_failure'),
                    raw_json, response.status_code
                )
                if response.status_code == 429:
                    error.account_failure = 'rate_limit'
                    import time
                    try:
                        headers = getattr(response, 'headers', None) or {}
                        seconds = float(headers.get('retry-after') or headers.get('Retry-After') or '0')
                        reset_val = headers.get('x-rate-limit-reset') or headers.get('X-Rate-Limit-Reset') or '0'
                        reset = float(reset_val) - time.time()
                        error.retry_after_seconds = min(900, max(60, seconds, reset))
                    except (ValueError, TypeError):
                        error.retry_after_seconds = 60
                raise error
            try:
                data = response.json()
            except ValueError:
                if not raise_exception:
                    return response.text, response
                raise TwitterException('direct_x_invalid_json') from None
            if 'CreateTweet' in str(url) or 'CreateNoteTweet' in str(url):
                self._last_create_tweet_response = data
            if isinstance(data, dict) and data.get('errors'):
                failure = classify_x_account_failure(raw_json=data, errors=data['errors'])
                has_valid_user_data = isinstance(data.get('data'), dict) and data['data'].get('user') is not None
                if not (has_valid_user_data and not failure):
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
                if not failure and reason.strip().lower() == 'suspended':
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
                if not failure and reason.strip().lower() == 'suspended':
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
            self._last_create_tweet_diag = None
            self._last_create_tweet_http_status = None
            response, http_response = await self.gql.create_tweet(
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
            status = getattr(http_response, 'status_code', None)
            if isinstance(status, int) and not isinstance(status, bool):
                self._last_create_tweet_http_status = status
            data = response.get('data') if isinstance(response, dict) else None
            node = data.get('notetweet_create' if is_note_tweet else 'create_tweet') if isinstance(data, dict) else None
            results = node.get('tweet_results') if isinstance(node, dict) else None
            raw = results.get('result') if isinstance(results, dict) else None
            tweet = direct_tweet_from_data(self, results)
            if tweet is not None:
                return tweet
            if not isinstance(node, dict):
                kind = 'missing_create_tweet'
            elif not isinstance(results, dict) or not results:
                kind = 'empty_tweet_results'
            elif 'result' in results and raw is None:
                kind = 'null_result'
            elif isinstance(raw, dict) and raw.get('__typename') in ('TweetTombstone', 'TweetUnavailable'):
                kind = 'tombstone'
            else:
                kind = 'unparseable'
            self._last_create_tweet_diag = {
                'kind': kind,
                'httpStatus': self._last_create_tweet_http_status,
                'transactionDegraded': bool(getattr(self.client_transaction, 'degraded', False)),
                'topLevelKeys': sorted(k for k in response if isinstance(k, str)) if isinstance(response, dict) else [],
            }
            return None

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

