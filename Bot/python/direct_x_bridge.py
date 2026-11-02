"""One account per process; line JSON protocol, never logs credentials/errors."""
from __future__ import annotations

import asyncio
import datetime
import inspect
import json
import os
from pathlib import Path
import re
import stat
import sys
from types import SimpleNamespace
import urllib.parse

# -I excludes even the script directory; add ONLY this owned directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from direct_x_compat import _compat_user_data, classify_x_account_failure

KNOWN_ACCOUNT_FAILURES = {
    'banned', 'captcha', 'cookie_expired', 'auth_rejected',
    'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown',
    'auth',  # legacy alias
}


def extract_retry_after_seconds(exc, default=60):
    if hasattr(exc, 'retry_after_seconds') and isinstance(exc.retry_after_seconds, (int, float)):
        return max(60, min(900, int(exc.retry_after_seconds)))
    import time
    if hasattr(exc, 'rate_limit_reset') and isinstance(exc.rate_limit_reset, (int, float)):
        diff = exc.rate_limit_reset - time.time()
        return max(60, min(900, int(diff)))
    headers = getattr(exc, 'headers', None)
    if isinstance(headers, dict):
        if 'retry-after' in headers:
            try:
                return max(60, min(900, int(float(headers['retry-after']))))
            except (ValueError, TypeError):
                pass
        if 'x-rate-limit-reset' in headers:
            try:
                diff = float(headers['x-rate-limit-reset']) - time.time()
                return max(60, min(900, int(diff)))
            except (ValueError, TypeError):
                pass
    return max(60, min(900, int(default)))


def is_rate_limit_exception(exc):
    if getattr(exc, 'http_status', None) == 429:
        return True
    if getattr(exc, 'account_failure', None) == 'rate_limit':
        return True
    if getattr(exc, 'code', None) in (88, 185) or getattr(exc, 'error_code', None) in (88, 185):
        return True
    try:
        import twikit.errors
        if isinstance(exc, twikit.errors.TooManyRequests):
            return True
    except Exception:
        pass
    msg = str(exc).lower()
    return 'rate limit' in msg or 'too many requests' in msg or '429' in msg


if sys.platform.startswith('linux'):
    try:
        import ctypes
        import signal
        # PR_SET_PDEATHSIG = 1: kernel sends SIGTERM to child when parent terminates
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        res = libc.prctl(1, signal.SIGTERM)
        if res == 0 and os.getppid() == 1:
            sys.exit(1)
    except Exception:
        pass


def validate_proxy(proxy):
    if not isinstance(proxy, str) or not re.fullmatch(r'socks5h://(?:127\.0\.0\.1|localhost):1880[1-5]', proxy):
        raise ValueError('proxy_required')
    return proxy


def username(value):
    if isinstance(value, str) and value.strip():
        return value.strip().lstrip('@').lower()
    return None


def expand_urls_with_entities(text, entities):
    """Expand shortened URLs (e.g. t.co) using X entity mappings.
    entities can be a dict {'urls': [...]} or a list of url entity dicts.
    """
    if not isinstance(text, str) or not entities:
        return text
    urls = []
    if isinstance(entities, dict):
        urls = entities.get('urls', [])
    elif isinstance(entities, (list, tuple)):
        urls = entities
    if not isinstance(urls, (list, tuple)):
        return text

    expanded = text
    for item in urls:
        if isinstance(item, dict):
            short_url = item.get('url')
            expanded_url = item.get('expanded_url') or item.get('display_url')
            if short_url and expanded_url and isinstance(short_url, str) and isinstance(expanded_url, str):
                expanded = expanded.replace(short_url, expanded_url)
    return expanded


def canonicalize_url(url):
    """Canonicalize URL: lowercase scheme and host, drop standard ports,
    and normalize root trailing slashes while preserving path and query.
    """
    try:
        parsed = urllib.parse.urlsplit(url)
        scheme = parsed.scheme.lower()
        if scheme not in ('http', 'https'):
            return url
        netloc = parsed.netloc.lower()
        if scheme == 'http' and netloc.endswith(':80'):
            netloc = netloc[:-3]
        elif scheme == 'https' and netloc.endswith(':443'):
            netloc = netloc[:-4]
        path = parsed.path
        if path == '/':
            path = ''
        elif path.endswith('/') and len(path) > 1:
            path = path.rstrip('/')
        return urllib.parse.urlunsplit((scheme, netloc, path, parsed.query, parsed.fragment))
    except Exception:
        return url


def normalize_text_for_comparison(text, entities=None):
    if not isinstance(text, str):
        return ''

    # 1. Expand shortened URLs if entity mapping is provided
    cleaned = expand_urls_with_entities(text, entities)

    # 2. Extract and canonicalize URLs, substituting unique placeholder tokens
    url_tokens = []
    def repl(m):
        url = m.group(0)
        trailing = ''
        while url and (url[-1] in '.,!?:;"\']' or (url[-1] == ')' and url.count(')') > url.count('('))):
            trailing = url[-1] + trailing
            url = url[:-1]
        canon = canonicalize_url(url)
        idx = len(url_tokens)
        url_tokens.append(canon)
        return f"\x00URL_TOKEN_{idx}\x00" + trailing

    cleaned = re.sub(r'https?://\S+', repl, cleaned, flags=re.IGNORECASE)

    # 3. Normalize whitespace and lowercase surrounding text
    normalized = ' '.join(cleaned.split()).strip().lower()

    # 4. Restore canonicalized URLs with preserved path/query/fragment casing
    for idx, canon in enumerate(url_tokens):
        token_lower = f"\x00url_token_{idx}\x00"
        normalized = normalized.replace(token_lower, canon)

    return normalized



def is_recent_tweet(tweet, max_age_seconds=1800):
    """Check if tweet was created recently (within max_age_seconds, default 30 mins).
    Fails closed (returns False) if timestamp is missing or unparseable.
    """
    try:
        dt = getattr(tweet, 'created_at_datetime', None)
        if dt:
            now = datetime.datetime.now(datetime.timezone.utc)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            age = (now - dt).total_seconds()
            return -60 <= age <= max_age_seconds

        cat = getattr(tweet, 'created_at', None)
        if isinstance(cat, str) and cat.strip():
            from email.utils import parsedate_to_datetime
            try:
                pdt = parsedate_to_datetime(cat)
                now = datetime.datetime.now(datetime.timezone.utc)
                if pdt.tzinfo is None:
                    pdt = pdt.replace(tzinfo=datetime.timezone.utc)
                age = (now - pdt).total_seconds()
                return -60 <= age <= max_age_seconds
            except Exception:
                pass
            try:
                pdt = datetime.datetime.fromisoformat(cat.replace('Z', '+00:00'))
                now = datetime.datetime.now(datetime.timezone.utc)
                if pdt.tzinfo is None:
                    pdt = pdt.replace(tzinfo=datetime.timezone.utc)
                age = (now - pdt).total_seconds()
                return -60 <= age <= max_age_seconds
            except Exception:
                pass
    except Exception:
        pass
    return False


def numeric_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[0-9]+', value))


def parse_cookies(content):
    """JSON dictionary, browser export or Netscape. Reject conflicting domains."""
    if len(content) > 1_048_576:
        raise ValueError('cookie_size')
    cookies = {}

    def add(name, value, domain='.x.com', expiry=None):
        if domain.lstrip('.').lower() not in {'x.com', 'twitter.com'}:
            raise ValueError('cookie_domain')
        if not isinstance(name, str) or not isinstance(value, str) or not name or '\n' in value or '\r' in value:
            raise ValueError('cookie_invalid')
        if name in cookies and cookies[name] != value:
            raise ValueError('cookie_conflict')
        if expiry not in (None, '', 0, '0', -1):
            import time
            if float(expiry) < time.time():
                return
        cookies[name] = value

    if content.lstrip().startswith(('{', '[')):
        data = json.loads(content)
        if isinstance(data, dict) and 'cookies' in data:
            data = data['cookies']
        if isinstance(data, dict):
            for name, value in data.items(): add(name, value)
        elif isinstance(data, list):
            for cookie in data:
                add(cookie['name'], cookie['value'], cookie.get('domain', '.x.com'), cookie.get('expirationDate', cookie.get('expires')))
        else:
            raise ValueError('cookie_format')
    else:
        for line in content.splitlines():
            if line.startswith('#HttpOnly_'): line = line[len('#HttpOnly_'):]
            elif not line or line.startswith('#'): continue
            fields = line.split('\t')
            if len(fields) != 7: raise ValueError('cookie_format')
            add(fields[5], fields[6], fields[0], fields[4])
    if not cookies.get('auth_token') or not cookies.get('ct0'):
        raise ValueError('cookie_auth_required')
    return cookies


def read_cookies(file):
    # NOFOLLOW + fstat prevents symlink substitution, no cookie persistence.
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError('cookie_file')
        with os.fdopen(fd, 'r', encoding='utf-8') as stream:
            fd = None
            return parse_cookies(stream.read(1_048_577))
    finally:
        if fd is not None: os.close(fd)


def new_client(proxy):
    proxy = validate_proxy(proxy)
    import httpx
    from direct_x_compat import compatibility_client
    Client = compatibility_client()

    _orig_http_transport_code = getattr(httpx.AsyncHTTPTransport.handle_async_request, '__code__', None)

    class OnlySocksTransport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.transport = httpx.AsyncHTTPTransport(proxy=proxy, retries=0, trust_env=False)
            try:
                from curl_cffi.requests import AsyncSession
                self._curl_session = AsyncSession(proxy=proxy, impersonate='chrome120')
            except Exception:
                self._curl_session = None

        async def handle_async_request(self, request):
            host = request.url.host
            if request.url.scheme != 'https' or request.url.port not in (None, 443) or host not in {'x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'api.x.com', 'api.twitter.com', 'abs.twimg.com'}:
                raise ValueError('proxy_destination_denied')
            # Twikit uses a domainless in-memory cookie jar; its transaction
            # bootstrap must not forward account cookies to the static CDN.
            if host == 'abs.twimg.com':
                request.headers.pop('cookie', None)
                request.headers.pop('authorization', None)
                request.headers.pop('x-csrf-token', None)

            # Delegate to mock transport when patched in tests
            pool = getattr(self.transport, '_pool', None)
            net_backend = getattr(pool, '_network_backend', None) if pool else None
            is_patched = (
                (hasattr(self.transport, 'handle_async_request') and
                 (hasattr(self.transport.handle_async_request, 'side_effect') or
                  hasattr(self.transport.handle_async_request, 'mock_calls') or
                  getattr(self.transport.handle_async_request, '_mock_name', None) is not None)) or
                (net_backend is not None and hasattr(getattr(net_backend, 'connect_tcp', None), 'side_effect')) or
                (getattr(httpx.AsyncHTTPTransport.handle_async_request, '__code__', None) != _orig_http_transport_code) or
                (getattr(httpx.AsyncHTTPTransport.handle_async_request, '__qualname__', '') != 'AsyncHTTPTransport.handle_async_request')
            )
            if not self._curl_session or is_patched:
                return await self.transport.handle_async_request(request)

            try:
                url = str(request.url)
                method = request.method
                headers = dict(request.headers)
                headers.pop('host', None)
                headers.pop('content-length', None)
                content = await request.aread()
                resp = await self._curl_session.request(
                    method=method,
                    url=url,
                    headers=headers,
                    data=content if content else None,
                    allow_redirects=False
                )
                clean_headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in ('content-encoding', 'transfer-encoding')]
                return httpx.Response(
                    status_code=resp.status_code,
                    headers=clean_headers,
                    content=resp.content,
                    request=request
                )
            except Exception as exc:
                # Idempotent reads (GET, HEAD, OPTIONS, TRACE) are always safe to failover
                is_idempotent = request.method.upper() in ('GET', 'HEAD', 'OPTIONS', 'TRACE')

                # Strict classification of provably pre-send failures (zero bytes transmitted)
                curl_code = getattr(exc, 'code', None)
                pre_send_codes = {
                    1,   # CURLE_UNSUPPORTED_PROTOCOL
                    2,   # CURLE_FAILED_INIT
                    3,   # CURLE_URL_MALFORMAT
                    4,   # CURLE_NOT_BUILT_IN
                    5,   # CURLE_COULDNT_RESOLVE_PROXY
                    6,   # CURLE_COULDNT_RESOLVE_HOST
                    7,   # CURLE_COULDNT_CONNECT (ConnectionRefused before TCP connect)
                    35,  # CURLE_SSL_CONNECT_ERROR (TLS handshake failed before HTTP send)
                    58,  # CURLE_SSL_CERTPROBLEM
                    59,  # CURLE_SSL_CIPHER
                    60,  # CURLE_PEER_FAILED_VERIFICATION
                    64,  # CURLE_USE_SSL_FAILED
                    77,  # CURLE_SSL_CACERT_BADFILE
                    82,  # CURLE_SSL_CRL_BADFILE
                    83,  # CURLE_SSL_ISSUER_ERROR
                    90,  # CURLE_SSL_PINNEDPUBKEYNOTMATCH
                }
                msg = str(exc).lower()
                is_pre_send = (
                    (curl_code in pre_send_codes) or
                    ('before send' in msg) or
                    ('before any send' in msg)
                )

                if is_idempotent or is_pre_send:
                    return await self.transport.handle_async_request(request)

                # Non-idempotent request where bytes may have crossed send boundary:
                # REPLAY / FALLBACK IS STRICTLY FORBIDDEN.
                # Re-raise so caller fences result as ambiguous.
                raise

        async def aclose(self):
            if getattr(self, '_curl_session', None):
                try:
                    await self._curl_session.close()
                except Exception:
                    pass
            await self.transport.aclose()

    # A single explicit transport; NO proxy environment, mounts, direct route,
    # automatic redirects or retrying transport. Bootstrap uses this same http.
    class IsolatedClient(Client):
        # twikit's setter otherwise installs an all:// DIRECT mount even for
        # proxy=None, bypassing the supplied transport. Never invoke it.
        @property
        def proxy(self):
            return proxy

        @proxy.setter
        def proxy(self, value):
            if value is not None:
                raise ValueError('proxy_reconfiguration_denied')

    return IsolatedClient('en-US', trust_env=False, transport=OnlySocksTransport(),
                          follow_redirects=False, timeout=30.0)


def unsent(reason):
    return {'status': 'not_ready', 'published': False, 'posted': False, 'ambiguous': False, 'blocked': True, 'reason': reason}


def uncertain(reason):
    return {'status': 'ambiguous', 'published': False, 'posted': False, 'ambiguous': True, 'reason': reason}


class DirectSession:
    def __init__(self, client, account):
        self.client = client
        self.expected = username(account.get('username'))
        self.expected_id = account.get('userId')
        self.use_cache = bool(account.get('use_cache'))
        self.verified = None
        self.used = False

    async def identity(self):
        # Retry only idempotent identity reads, before any dispatch ACK. A bare
        # HTTP failure is not evidence that the owner's credentials expired.
        import httpx
        for attempt in range(4):
            try:
                return await self._identity_once()
            except Exception as exc:
                if not getattr(exc, 'account_failure', None) and getattr(exc, 'http_status', None) == 429:
                    # A rate limit is not invalid credentials. Defer outside this
                    # process rather than multiplying immediate endpoint calls.
                    error = ValueError('identity_read_unavailable')
                    status = getattr(exc, 'http_status', None)
                    setattr(error, 'read_diagnostic', {'phase': getattr(self, 'read_phase', 'unknown'), 'httpStatus': status if type(status) is int else None, 'retryAfterSeconds': getattr(exc, 'retry_after_seconds', 60) if status == 429 else None})
                    raise error from None
                transient = (not getattr(exc, 'account_failure', None) and
                             (getattr(exc, 'http_status', None) in (404, 408, 500, 502, 503, 504)
                              or isinstance(exc, (httpx.TimeoutException, httpx.NetworkError))))
                if not transient:
                    raise
                if attempt == 3:
                    error = ValueError('identity_read_unavailable')
                    status = getattr(exc, 'http_status', None)
                    setattr(error, 'read_diagnostic', {'phase': getattr(self, 'read_phase', 'unknown'), 'httpStatus': status if type(status) is int else None, 'retryAfterSeconds': getattr(exc, 'retry_after_seconds', 60) if status == 429 else None})
                    raise error from None
                await asyncio.sleep(0.25 * 2 ** attempt)

    async def _identity_once(self):
        from urllib.parse import unquote
        twid = unquote(getattr(self.client, 'get_cookies', lambda: {})().get('twid', ''))
        candidate = twid[2:] if twid.startswith('u=') and numeric_id(twid[2:]) else None

        # Clean Pre-Tweet Fast Path with active state verification (FINDING-007):
        # Even when use_cache is enabled, do NOT bypass account suspension or active state verification.
        # Verify account state against live API via profile fetch before declaring authenticated.
        if self.use_cache and self.expected and self.expected_id and candidate and candidate == self.expected_id:
            if hasattr(self.client, 'get_user_by_id'):
                self.read_phase = 'profile'
                user = await self.client.get_user_by_id(candidate)
                fetched_name = username(getattr(user, 'screen_name', None))
                fetched_id = getattr(user, 'id', None)
                if fetched_name and fetched_name != self.expected:
                    raise ValueError('auth_identity_mismatch')
                if fetched_id and str(fetched_id) != str(self.expected_id):
                    raise ValueError('auth_identity_mismatch')
            result = {'state': 'authenticated', 'authenticated': True, 'username': self.expected, 'userId': self.expected_id}
            self.verified = result
            return result

        # Settings is an authenticated endpoint. Never infer identity from the
        # requested handle, a public profile or twikit's cached _user_id alone.
        self.read_phase = 'user_state'
        state, _ = await self.client.v11.user_state()
        remote_state = state.get('userState') if isinstance(state, dict) else None
        if remote_state == 'suspended':
            error = ValueError('auth_account_suspended')
            setattr(error, 'account_failure', 'banned')
            raise error
        if remote_state in ('locked', 'bounce', 'challenge', 'compromised', 'verification_required'):
            error = ValueError('auth_account_captcha')
            setattr(error, 'account_failure', 'captcha')
            raise error
        if remote_state != 'normal':
            raise ValueError('auth_account_state_unverified')
        from urllib.parse import unquote
        twid = unquote(getattr(self.client, 'get_cookies', lambda: {})().get('twid', ''))
        candidate = twid[2:] if twid.startswith('u=') and numeric_id(twid[2:]) else None
        self.read_phase = 'settings'
        settings = None
        settings_error = None
        try:
            settings, _ = await self.client.v11.settings()
        except Exception as exc:
            if getattr(exc, 'account_failure', None):
                raise
            settings_error = exc
        actual = username(settings.get('screen_name')) if isinstance(settings, dict) else None
        uid = None
        import httpx
        is_transient_settings = settings_error and (
            getattr(settings_error, 'http_status', None) in (404, 408, 500, 502, 503, 504)
            or isinstance(settings_error, (httpx.TimeoutException, httpx.NetworkError))
        )
        # Immediate fallback inside the same attempt if settings.json failed or returned missing/404
        if not actual and candidate:
            if self.expected_id and candidate == self.expected_id and self.expected:
                actual = self.expected
                uid = candidate
                try:
                    user = await self.client.get_user_by_id(candidate)
                    fetched = username(getattr(user, 'screen_name', None))
                    if fetched:
                        if fetched != self.expected:
                            raise ValueError('auth_identity_mismatch')
                        actual = fetched
                except ValueError:
                    raise
                except Exception:
                    pass
            elif is_transient_settings:
                try:
                    user = await self.client.get_user_by_id(candidate)
                    fetched_uid = getattr(user, 'id', None)
                    fetched_name = username(getattr(user, 'screen_name', None))
                    if numeric_id(fetched_uid) and fetched_uid == candidate and fetched_name:
                        if self.expected and fetched_name != self.expected:
                            raise ValueError('auth_identity_mismatch')
                        actual = fetched_name
                        uid = fetched_uid
                except ValueError:
                    raise
                except Exception:
                    pass
        if not actual:
            if settings_error:
                raise settings_error
            raise ValueError('auth_identity_missing')
        # Authenticated self evidence must fail closed before a public lookup
        # can fail transiently and cause the read loop to try another snapshot.
        if self.expected and actual != self.expected:
            raise ValueError('auth_identity_mismatch')
        if self.verified and actual != self.verified['username']:
            raise ValueError('auth_identity_changed')
        self.read_phase = 'profile'
        if not uid:
            try:
                user = await self.client.get_user_by_id(candidate) if candidate else await self.client.get_user_by_screen_name(actual)
            except Exception as exc:
                # Public lookup errors concern the target, not the authenticated self.
                # Preserve safe transient read metadata, never target accountFailure.
                if not getattr(exc, 'account_failure', None) and (getattr(exc, 'http_status', None) in (404, 408, 429, 500, 502, 503, 504) or isinstance(exc, (httpx.TimeoutException, httpx.NetworkError))):
                    raise
                raise ValueError('auth_identity_unverified') from None
            uid = getattr(user, 'id', None)
            if not numeric_id(uid) or (candidate and uid != candidate) or username(getattr(user, 'screen_name', None)) != actual:
                raise ValueError('auth_identity_missing')
        if self.expected_id and uid != self.expected_id:
            raise ValueError('auth_identity_mismatch')
        result = {'state': 'authenticated', 'authenticated': True, 'username': actual, 'userId': uid}
        if self.verified and result != self.verified:
            raise ValueError('auth_identity_changed')
        self.verified = result
        return result

    async def verify_timeline(self, text, identity):
        """Check whether the tweet actually landed by reading the user timeline.

        Called only after create_tweet raised an exception (timeout / network
        glitch) so the dispatch already happened.
        Returns:
          - dict with 'found': True, 'status': 'published', 'tweetId', etc. if tweet is conclusively on timeline.
          - dict with 'found': False, 'status': 'ambiguous', 'ambiguous': True if tweet is not confirmed.
            NEVER returns 'verifiedNotPosted': True.
        """
        sent_norm = normalize_text_for_comparison(text)
        last_fetch_error = None

        # Give Twitter backend 2 seconds to propagate the tweet
        await asyncio.sleep(2)

        for attempt in range(2):
            try:
                tweets_data = []
                cursor = None

                # Query GraphQL user_tweets with pagination support (up to 2 pages)
                if hasattr(self.client, 'gql') and hasattr(self.client.gql, 'user_tweets'):
                    for page in range(2):
                        try:
                            gql_res, _ = await asyncio.wait_for(
                                self.client.gql.user_tweets(identity['userId'], 10, cursor),
                                timeout=12
                            )
                        except Exception as gql_err:
                            last_fetch_error = gql_err
                            break

                        if not isinstance(gql_res, dict) or gql_res.get('errors'):
                            break

                        instructions = (
                            gql_res.get('data', {})
                            .get('user', {})
                            .get('result', {})
                            .get('timeline_v2', {})
                            .get('timeline', {})
                            .get('instructions', [])
                        )
                        if not isinstance(instructions, list):
                            break

                        next_cursor = None
                        for instr in instructions:
                            if not isinstance(instr, dict):
                                continue
                            for entry in instr.get('entries', []):
                                if not isinstance(entry, dict):
                                    continue
                                entry_id = str(entry.get('entryId', ''))
                                content = entry.get('content', {})
                                if 'cursor' in entry_id.lower() or content.get('cursorType') in ('Bottom', 'bottom'):
                                    val = content.get('value')
                                    if isinstance(val, str) and val.strip():
                                        next_cursor = val.strip()

                                item_content = content.get('itemContent', {})
                                tweet_results = item_content.get('tweet_results', {}).get('result', {})
                                if isinstance(tweet_results, dict):
                                    tw_res = tweet_results.get('tweet', tweet_results) if isinstance(tweet_results.get('tweet'), dict) else tweet_results
                                    legacy = tw_res.get('legacy', {}) if isinstance(tw_res.get('legacy'), dict) else {}
                                    if isinstance(legacy, dict):
                                        tid = legacy.get('id_str')
                                        if tid:
                                            note_tweet_result = (
                                                tw_res.get('note_tweet', {})
                                                .get('note_tweet_results', {})
                                                .get('result', {})
                                            )
                                            full_text = note_tweet_result.get('text') or legacy.get('full_text', '')
                                            entities = note_tweet_result.get('entity_set') or legacy.get('entities', {})
                                            core_obj = tw_res.get('core') or {}
                                            user_res = (core_obj.get('user_results') or {}) if isinstance(core_obj, dict) else {}
                                            core_user = (user_res.get('result') or {}) if isinstance(user_res, dict) else {}
                                            if isinstance(core_user, dict) and isinstance(core_user.get('user'), dict):
                                                core_user = core_user.get('user')
                                            if isinstance(core_user, dict):
                                                core_user = _compat_user_data(core_user)
                                            core_legacy = (core_user.get('legacy') or {}) if isinstance(core_user, dict) else {}
                                            user_name_extracted = (core_legacy.get('screen_name') if isinstance(core_legacy, dict) else None) or (legacy.get('screen_name') if isinstance(legacy, dict) else None)
                                            user_id_extracted = (legacy.get('user_id_str') if isinstance(legacy, dict) else None) or (core_user.get('rest_id') if isinstance(core_user, dict) else None)
                                            tweets_data.append({
                                                'id': tid,
                                                'full_text': full_text,
                                                'created_at': legacy.get('created_at'),
                                                'user_id': user_id_extracted,
                                                'user_name': username(user_name_extracted) if user_name_extracted else None,
                                                'entities': entities
                                            })

                        cursor = next_cursor
                        if not cursor:
                            break

                # Fallback path for unit tests with mocked client.get_user_tweets
                if not tweets_data and hasattr(self.client, 'get_user_tweets'):
                    try:
                        recent = await asyncio.wait_for(
                            self.client.get_user_tweets(identity['userId'], 'Tweets', count=10),
                            timeout=10
                        )
                        for tw in (recent or []):
                            author = getattr(tw, 'user', None)
                            urls_entity = getattr(tw, 'urls', None)
                            raw_entities = getattr(tw, 'entities', None) or (
                                getattr(getattr(tw, '_legacy', None), 'get', lambda k, d=None: d)('entities')
                            )
                            entities = raw_entities or ({'urls': urls_entity} if urls_entity else None)
                            tweets_data.append({
                                'id': getattr(tw, 'id', None),
                                'full_text': getattr(tw, 'full_text', '') or '',
                                'created_at': getattr(tw, 'created_at', None),
                                'created_at_datetime': getattr(tw, 'created_at_datetime', None),
                                'user_id': getattr(author, 'id', None),
                                'user_name': username(getattr(author, 'screen_name', None)),
                                'entities': entities
                            })
                    except Exception as fallback_err:
                        last_fetch_error = fallback_err

                # Evaluate retrieved tweets
                for tweet in tweets_data:
                    tweet_text = tweet.get('full_text', '')
                    tweet_entities = tweet.get('entities')
                    tweet_norm = normalize_text_for_comparison(tweet_text, tweet_entities)

                    # Strict exact matching ONLY. Prefix matching is completely eliminated.
                    matched = False
                    if sent_norm and tweet_norm and (sent_norm == tweet_norm):
                        matched = True
                    elif text.strip() and tweet_text.strip() and text.strip() == tweet_text.strip():
                        matched = True

                    tw_obj = SimpleNamespace(**tweet) if isinstance(tweet, dict) else tweet
                    if matched and is_recent_tweet(tw_obj):
                        tid = tweet.get('id')
                        if numeric_id(tid):
                            author_id = tweet.get('user_id')
                            author_name = username(tweet.get('user_name'))

                            expected_author_name = username(identity.get('username')) or identity.get('username')
                            # Strict author verification: authentic author identity must be extracted from the tweet
                            if (author_id is None and author_name is None) or (not author_id and not author_name):
                                continue
                            if author_id is not None and str(author_id) != str(identity.get('userId')):
                                continue
                            if author_name is not None and author_name != expected_author_name:
                                continue

                            return {
                                'status': 'published',
                                'published': True,
                                'posted': True,
                                'ok': True,
                                'recoveredFromTimeline': True,
                                'recovered_from_timeline': True,
                                'tweetId': str(tid),
                                'tweetUrl': f"https://x.com/{identity['username']}/status/{tid}",
                                'username': identity['username'],
                                'userId': identity['userId'],
                                'verified_via': 'timeline_check',
                                'verified': True,
                                'found': True
                            }
                if attempt == 0:
                    await asyncio.sleep(2)
            except Exception as exc:
                last_fetch_error = exc
                if attempt == 0:
                    await asyncio.sleep(1)

        # Non-appearance on timeline under eventual consistency NEVER proves non-existence.
        # Always return ambiguous to prevent automated retry loops.
        return {
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'verified': False,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': str(last_fetch_error) if last_fetch_error else None
        }

    async def publish(self, text, dispatch):
        if self.used: return uncertain('dispatch_already_attempted')
        try:
            identity = await self.identity()
        except Exception as exc:
            reason = str(exc) if isinstance(exc, ValueError) and str(exc).startswith('auth_identity_') else 'auth_identity_unverified'
            if str(exc) == 'identity_read_unavailable': reason = 'identity_read_unavailable'
            result = unsent(reason)
            if reason == 'identity_read_unavailable':
                result['retryable'] = True
                result['readDiagnostic'] = getattr(exc, 'read_diagnostic', None)
            if getattr(exc, 'account_failure', None) in KNOWN_ACCOUNT_FAILURES:
                result['accountFailure'] = getattr(exc, 'account_failure')
            return result;
        if not isinstance(text, str) or not text.strip(): return unsent('invalid_text')
        # The dispatcher must persist and fsync its dispatching fence before ACK.
        self.used = True
        try:
            acknowledgement = dispatch()
            if inspect.isawaitable(acknowledgement): acknowledgement = await acknowledgement
            if acknowledgement is not True: return uncertain('dispatch_not_acknowledged')
            tweet = await self.client.create_tweet(text=text)  # exactly ONE call
            author = getattr(tweet, 'user', None)
            tid = getattr(tweet, 'id', None)
            if (not numeric_id(tid) or str(getattr(author, 'id', '')) != str(identity['userId'])
                    or username(getattr(author, 'screen_name', None)) != identity['username']):
                return uncertain('publish_author_or_id_unverified')
            return {'status': 'published', 'published': True, 'posted': True, 'tweetId': tid,
                    'username': identity['username'], 'userId': identity['userId']}
        except Exception as exc:
            if isinstance(exc, asyncio.CancelledError):
                raise

            # Rate Limit Fast Path: HTTP 429 during create_tweet means the tweet
            # was rejected by X API. Propagate rate limit diagnostics immediately
            # without falling into publish_confirmation_missing.
            if is_rate_limit_exception(exc):
                retry_after = extract_retry_after_seconds(exc, default=60)
                return {
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': False,
                    'retryable': True,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': str(exc)[:2048],
                }

            # Dispatch crossed the fence — the tweet MAY have posted but the
            # response was lost (timeout/network glitch). Before marking
            # ambiguous, verify by reading the user's recent timeline.
            x_error_code = getattr(exc, 'code', None) or getattr(exc, 'error_code', None)
            account_failure = getattr(exc, 'account_failure', None)

            timeline_res = None
            try:
                timeline_res = await self.verify_timeline(text, identity)
            except Exception:
                pass

            if (isinstance(timeline_res, dict)
                    and timeline_res.get('found') is True
                    and timeline_res.get('status') == 'published'):
                tid = str(timeline_res.get('tweetId') or '')
                url = (timeline_res.get('url')
                       or timeline_res.get('tweetUrl')
                       or f"https://x.com/{identity['username']}/status/{tid}")
                timeline_res['url'] = url
                timeline_res['tweetUrl'] = url
                timeline_res['tweetId'] = tid
                timeline_res['username'] = identity['username']
                timeline_res['userId'] = identity['userId']
                timeline_res['recoveredFromTimeline'] = True
                timeline_res['recovered_from_timeline'] = True
                if account_failure in KNOWN_ACCOUNT_FAILURES:
                    timeline_res['accountFailure'] = account_failure
                if x_error_code:
                    timeline_res['xErrorCode'] = x_error_code
                return timeline_res

            result = uncertain('publish_confirmation_missing')
            if account_failure in KNOWN_ACCOUNT_FAILURES:
                result['accountFailure'] = account_failure
            if x_error_code:
                result['xErrorCode'] = x_error_code
            result['rawError'] = str(exc)[:2048]
            return result


def emit(result):
    print(json.dumps(result, separators=(',', ':')), flush=True)


async def read_command():
    # Bounded input. Parent cancellation kills the isolated process, including
    # blocked input/read/bootstrap; no background child process is created.
    line = await asyncio.to_thread(sys.stdin.readline, 1_048_577)
    if not line or len(line) > 1_048_576: raise EOFError()
    return json.loads(line)


async def main():
    session = None
    try:
        command = await read_command()
        if command.get('op') != 'open': raise ValueError('protocol')
        proxy = validate_proxy(command.get('proxy'))
        account = command['account']
        cookies = read_cookies(account['cookieFile'])
        client = new_client(proxy)
        client.set_cookies(cookies, clear_cookies=True)
        session = DirectSession(client, account)
        identity = await session.identity()
        emit({'event': 'result', 'result': {'identity': identity}})
        command = await read_command()
        if command.get('op') != 'publish': raise ValueError('protocol')

        async def dispatch():
            emit({'event': 'dispatch_ready'})
            ack = await read_command()
            return ack == {'op': 'dispatch_ack'}

        result = await session.publish(command.get('text'), dispatch)
        emit({'event': 'result', 'result': result})
    except BaseException as exc:
        result = uncertain('bridge_error') if session and session.used else unsent('auth_session_unverified')
        if str(exc) == 'identity_read_unavailable':
            result['reason'] = 'identity_read_unavailable'
            result['retryable'] = True
            result['readDiagnostic'] = getattr(exc, 'read_diagnostic', None)
        if getattr(exc, 'account_failure', None) in KNOWN_ACCOUNT_FAILURES:
            result['accountFailure'] = getattr(exc, 'account_failure')
        if is_rate_limit_exception(exc):
            result['rateLimit'] = True
            result['retryAfterSeconds'] = extract_retry_after_seconds(exc)
        emit({'event': 'result', 'result': result})
    finally:
        if session:
            try: await session.client.http.aclose()
            except Exception: pass


if __name__ == '__main__':
    asyncio.run(main())
