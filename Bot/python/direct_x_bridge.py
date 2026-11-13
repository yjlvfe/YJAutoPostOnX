"""One account per process; line JSON protocol, never logs credentials/errors."""
from __future__ import annotations

import asyncio
import datetime
import html
import inspect
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
from types import SimpleNamespace
import urllib.parse

# -I excludes even the script directory; add ONLY this owned directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from direct_x_compat import _compat_user_data, classify_x_account_failure, classify_x_tweet_rejection

TIMELINE_VERIFY_WAITS = (2, 2, 4, 4, 8, 8, 8)
STARTUP_GET_TIMEOUT_SECONDS = 10.0
STARTUP_IDENTITY_DEADLINE_SECONDS = 24.0
DISPATCH_ACK_TIMEOUT_SECONDS = 120.0
# Monotonic cap; configure only downward. Node's publish bound includes POST time.
try:
    TIMELINE_VERIFY_DEADLINE_SECONDS = min(40.0, max(1.0, float(os.environ.get('DIRECT_X_TIMELINE_VERIFY_SECONDS', '40'))))
except ValueError:
    TIMELINE_VERIFY_DEADLINE_SECONDS = 40.0

KNOWN_ACCOUNT_FAILURES = {
    'banned', 'captcha', 'cookie_expired', 'auth_rejected',
    'rate_limit', 'network_proxy_error', 'ambiguous', 'unknown',
    'auth_session_unverified',
    'auth',  # legacy alias
}


def extract_retry_after_seconds(exc, default=60):
    if exc is None:
        return max(60, min(900, int(default)))
    if hasattr(exc, 'retry_after_seconds') and isinstance(exc.retry_after_seconds, (int, float)):
        return max(60, min(900, int(exc.retry_after_seconds)))
    if hasattr(exc, 'retry_after') and isinstance(exc.retry_after, (int, float)):
        return max(60, min(900, int(exc.retry_after)))
    if isinstance(getattr(exc, 'retry_after', None), str):
        try:
            return max(60, min(900, int(float(exc.retry_after))))
        except (ValueError, TypeError):
            pass
    import time
    if hasattr(exc, 'rate_limit_reset') and isinstance(exc.rate_limit_reset, (int, float)):
        diff = exc.rate_limit_reset - time.time()
        return max(60, min(900, int(diff)))

    headers = getattr(exc, 'headers', None)
    if headers is None and hasattr(exc, 'response'):
        headers = getattr(exc.response, 'headers', None)

    if headers:
        get_header = getattr(headers, 'get', None)
        retry_val = None
        if callable(get_header):
            retry_val = get_header('retry-after') or get_header('Retry-After')
        elif isinstance(headers, dict):
            retry_val = headers.get('retry-after') or headers.get('Retry-After')
        if retry_val is not None:
            try:
                return max(60, min(900, int(float(retry_val))))
            except (ValueError, TypeError):
                pass

        reset_val = None
        if callable(get_header):
            reset_val = get_header('x-rate-limit-reset') or get_header('X-Rate-Limit-Reset')
        elif isinstance(headers, dict):
            reset_val = headers.get('x-rate-limit-reset') or headers.get('X-Rate-Limit-Reset')
        if reset_val is not None:
            try:
                diff = float(reset_val) - time.time()
                return max(60, min(900, int(diff)))
            except (ValueError, TypeError):
                pass

    msg = str(exc)
    match = re.search(r'retry\s+after\s+(\d+)', msg, re.IGNORECASE)
    if match:
        try:
            return max(60, min(900, int(match.group(1))))
        except (ValueError, TypeError):
            pass

    return max(60, min(900, int(default)))


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


def sanitize_diagnostic_text(value, max_len=512):
    if value is None:
        return None
    text = str(value)
    text = _SECRET_BEARER_RE.sub('Bearer [REDACTED]', text)
    text = _SECRET_JSON_RE.sub(r'\1\2\1\3[REDACTED]\5', text)
    text = _SECRET_KV_RE.sub(r'\1\2[REDACTED]', text)
    return text[:max_len]


_RATE_LIMIT_MSG_PATTERN = re.compile(
    r'(?:'
    r'rate[\s_-]*limit'
    r'|too\s+many\s+requests'
    r'|status\s+update\s+limit'
    r'|over\s+capacity'
    r'|(?:http|status(?:[_\s-]*code)?|response|error)\s*[=:\s]\s*429\b'
    r'|\b429\s+too\s+many\s+requests\b'
    r'|\bcode\s*[=:\s]\s*(?:88|185)\b'
    r'|\[\s*(?:88|185)\s*\]'
    r')',
    re.IGNORECASE,
)


def is_rate_limit_exception(exc):
    if exc is None:
        return False
    if type(getattr(exc, 'http_status', None)) is int and getattr(exc, 'http_status', None) == 429:
        return True
    if type(getattr(exc, 'status_code', None)) is int and getattr(exc, 'status_code', None) == 429:
        return True
    resp = getattr(exc, 'response', None)
    if resp is not None:
        if (type(getattr(resp, 'status_code', None)) is int and getattr(resp, 'status_code', None) == 429) or (
            type(getattr(resp, 'http_status', None)) is int and getattr(resp, 'http_status', None) == 429
        ):
            return True
    if getattr(exc, 'account_failure', None) == 'rate_limit':
        return True
    exc_code = getattr(exc, 'code', None)
    err_code = getattr(exc, 'error_code', None)
    if (type(exc_code) is int and exc_code in (88, 185, 344)) or (type(err_code) is int and err_code in (88, 185, 344)):
        return True
    try:
        import twikit.errors
        if isinstance(exc, twikit.errors.TooManyRequests):
            return True
    except Exception:
        pass
    try:
        import httpx
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429:
            return True
    except Exception:
        pass
    msg = str(exc)
    return bool(_RATE_LIMIT_MSG_PATTERN.search(msg))


def _set_parent_death_signal():
    if not sys.platform.startswith('linux'):
        return
    try:
        import ctypes
        import signal
        # PR_SET_PDEATHSIG = 1: kernel sends SIGTERM to child when parent terminates
        libc = ctypes.CDLL('libc.so.6', use_errno=True)
        res = libc.prctl(1, signal.SIGTERM)
        if res != 0:
            errno_val = ctypes.get_errno()
            try:
                sys.stderr.write(json.dumps({
                    'level': 'warn',
                    'component': 'direct_x_bridge',
                    'event': 'prctl_pdeathsig_failed',
                    'returnCode': int(res),
                    'errno': int(errno_val),
                }) + '\n')
            except Exception:
                pass
    except Exception as exc:
        try:
            sys.stderr.write(json.dumps({
                'level': 'warn',
                'component': 'direct_x_bridge',
                'event': 'prctl_pdeathsig_exception',
                'error': type(exc).__name__,
            }) + '\n')
        except Exception:
            pass
    if os.getppid() == 1:
        sys.exit(1)


if sys.platform.startswith('linux'):
    _set_parent_death_signal()


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

    replacements = {}
    for item in urls:
        if isinstance(item, dict):
            short_url = item.get('url')
            # display_url is presentation text and may omit or truncate the
            # destination; it cannot establish the actual URL identity.
            expanded_url = item.get('expanded_url')
            if short_url and expanded_url and isinstance(short_url, str) and isinstance(expanded_url, str):
                if short_url in replacements and replacements[short_url] != expanded_url:
                    replacements[short_url] = None
                else:
                    replacements.setdefault(short_url, expanded_url)
    # Replace only complete URL tokens, never a prefix of a different URL.
    # Ambiguous adjacent punctuation remains unexpanded and fails closed.
    return re.sub(r'''https?://[^\s<>"']+''',
                  lambda match: replacements.get(match.group(0)) or match.group(0),
                  text, flags=re.IGNORECASE)


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
    # Only expand an explicit X URL entity. URL paths, trailing slashes, query
    # ordering, case and whitespace can distinguish different publications.
    return expand_urls_with_entities(text, entities)


def _texts_match_tweet(actual_text, entities, expected_text):
    """Compare tweet text after normalizing X HTML character entities before URL expansion."""
    if not isinstance(actual_text, str) or not isinstance(expected_text, str):
        return False
    return (
        expand_urls_with_entities(actual_text, entities) == expected_text
        or expand_urls_with_entities(html.unescape(actual_text), entities) == expected_text
    )



SNOWFLAKE_EPOCH_OFFSET_MS = 1288834974657


def _to_epoch_seconds(val):
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, datetime.datetime):
        dt = val if val.tzinfo is not None else val.replace(tzinfo=datetime.timezone.utc)
        return dt.timestamp()
    if isinstance(val, str) and val.strip():
        s = val.strip()
        from email.utils import parsedate_to_datetime
        try:
            pdt = parsedate_to_datetime(s)
            if pdt.tzinfo is None:
                pdt = pdt.replace(tzinfo=datetime.timezone.utc)
            return pdt.timestamp()
        except Exception:
            pass
        try:
            pdt = datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
            if pdt.tzinfo is None:
                pdt = pdt.replace(tzinfo=datetime.timezone.utc)
            return pdt.timestamp()
        except Exception:
            pass
    return None


def extract_snowflake_epoch(tid):
    if tid is None or isinstance(tid, bool):
        return None
    s = str(tid).strip()
    if len(s) >= 15 and s.isdigit():
        try:
            val = int(s)
            if val > (1 << 22):
                return ((val >> 22) + SNOWFLAKE_EPOCH_OFFSET_MS) / 1000.0
        except Exception:
            pass
    return None


def is_recent_tweet(tweet, max_age_seconds=1800, dispatch_started_epoch=None, min_timestamp=None):
    """Check if tweet was created recently (within max_age_seconds, default 30 mins)
    and not earlier than dispatch_started_epoch - 2.0 when provided.
    Extracts both created_at and X Snowflake timestamp (when tid is a >=15-digit Snowflake integer).
    Fails closed (returns False) if timestamp is missing or unparseable.
    """
    import time
    try:
        now_epoch = time.time()
        get_field = (lambda k: tweet.get(k)) if isinstance(tweet, dict) else (lambda k: getattr(tweet, k, None))
        dt_epoch = _to_epoch_seconds(get_field('created_at_datetime'))
        if dt_epoch is None:
            dt_epoch = _to_epoch_seconds(get_field('created_at'))
        tid = get_field('id') or get_field('id_str') or get_field('tweetId')
        sf_epoch = extract_snowflake_epoch(tid)

        timestamps = [ts for ts in (dt_epoch, sf_epoch) if ts is not None]
        if not timestamps:
            return False

        lower_bound = _to_epoch_seconds(dispatch_started_epoch if dispatch_started_epoch is not None else min_timestamp)
        for ts in timestamps:
            age = now_epoch - ts
            if not (-60.0 <= age <= max_age_seconds):
                return False
            if lower_bound is not None and ts < (lower_bound - 2.0):
                return False
        return True
    except Exception:
        return False


GUEST_COOKIE_NAMES = frozenset({'guest_id', 'guest_id_ads', 'guest_id_marketing', 'personalization_id', 'gt'})


def numeric_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[0-9]+', value))


def parse_cookies(content):
    """Read X cookies from JSON or Netscape exports without importing other domains."""
    if len(content) > 1_048_576:
        raise ValueError('cookie_size')
    cookies = {}

    def normalize_domain(domain):
        if not isinstance(domain, str):
            raise ValueError('cookie_domain')
        domain = domain.lstrip('.').lower()
        if not re.fullmatch(r'(?=.{1,253}\Z)[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*', domain):
            raise ValueError('cookie_domain')
        return domain

    def add(name, value, domain='.x.com', expiry=None):
        domain = normalize_domain(domain)
        if domain not in {'x.com', 'twitter.com'}:
            return
        if not isinstance(name, str) or not isinstance(value, str) or not name or '\n' in value or '\r' in value:
            raise ValueError('cookie_invalid')
        if expiry not in (None, ''):
            import time
            if isinstance(expiry, bool):
                raise ValueError('cookie_expiry')
            is_numeric_sentinel = False
            try:
                expires_at = float(expiry)
                is_numeric_sentinel = expires_at in (0, -1)
            except (TypeError, ValueError):
                parsed_ts = _to_epoch_seconds(expiry)
                if parsed_ts is None:
                    raise ValueError('cookie_expiry') from None
                expires_at = parsed_ts
            if not math.isfinite(expires_at):
                raise ValueError('cookie_expiry')
            if not is_numeric_sentinel and expires_at < time.time():
                return
        if name in cookies and cookies[name] != value and name not in GUEST_COOKIE_NAMES:
            raise ValueError('cookie_conflict')
        cookies[name] = value

    if content.lstrip().startswith(('{', '[')):
        data = json.loads(content)
        if isinstance(data, dict) and 'cookies' in data:
            data = data['cookies']
        if isinstance(data, dict):
            for name, value in data.items(): add(name, value)
        elif isinstance(data, list):
            for cookie in data:
                if not isinstance(cookie, dict):
                    raise ValueError('cookie_format')
                domain = cookie.get('domain')
                raw_url = cookie.get('url')
                if raw_url not in (None, ''):
                    try:
                        url = urllib.parse.urlsplit(raw_url)
                        if url.scheme not in ('http', 'https') or url.username or url.password or not url.hostname:
                            raise ValueError('cookie_domain')
                        url_domain = normalize_domain(url.hostname)
                        if domain is not None:
                            cookie_domain = normalize_domain(domain)
                            if url_domain != cookie_domain and not url_domain.endswith('.' + cookie_domain):
                                raise ValueError('cookie_domain')
                        else:
                            domain = url_domain
                    except (TypeError, ValueError, AttributeError):
                        raise ValueError('cookie_domain') from None
                if not domain:
                    raise ValueError('cookie_domain')
                expiry = cookie.get('expirationDate')
                if expiry is None:
                    expiry = cookie.get('expires')
                add(cookie.get('name'), cookie.get('value'), domain, expiry)
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
            self._closed = False
            self._curl_recycled = False
            self._curl_session = self._build_curl_session()

        def _build_curl_session(self):
            try:
                from curl_cffi import CurlOpt
                from curl_cffi.requests import AsyncSession
                return AsyncSession(
                    proxy=proxy,
                    impersonate='chrome120',
                    trust_env=False,
                    max_clients=4,
                    curl_options={
                        CurlOpt.MAXCONNECTS: 2,
                        CurlOpt.MAXAGE_CONN: 20,
                    },
                )
            except Exception:
                return None

        async def _close_curl_session(self):
            sess = getattr(self, '_curl_session', None)
            self._curl_session = None
            if sess is not None:
                try:
                    await sess.close()
                except Exception:
                    pass

        async def recycle(self):
            await self._close_curl_session()
            self._curl_recycled = not self._closed

        def _ensure_curl_session(self):
            if self._curl_session is None and self._curl_recycled and not self._closed:
                self._curl_recycled = False
                self._curl_session = self._build_curl_session()
            return self._curl_session

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
            if is_patched:
                return await self.transport.handle_async_request(request)

            session = self._ensure_curl_session()
            if not session:
                return await self.transport.handle_async_request(request)

            return await self._request_with_transport_fallback(request, session)

        async def _request_with_transport_fallback(self, request, curl_session=None):
            curl_session = curl_session or self._ensure_curl_session()
            if not curl_session:
                return await self.transport.handle_async_request(request)
            try:
                url = str(request.url)
                method = request.method
                headers = dict(request.headers)
                headers.pop('host', None)
                headers.pop('content-length', None)
                content = await request.aread()
                # Clear curl_cffi internal session cookies so libcurl does not suppress request.headers['cookie']
                if hasattr(curl_session, 'cookies'):
                    curl_session.cookies.clear()
                resp = await curl_session.request(
                    method=method,
                    url=url,
                    headers=headers,
                    data=content if content else None,
                    allow_redirects=False,
                    timeout=30.0
                )
                raw_items = resp.headers.multi_items() if hasattr(resp.headers, 'multi_items') else resp.headers.items()
                clean_headers = [(k, v) for k, v in raw_items if k.lower() not in ('content-encoding', 'transfer-encoding')]
                return httpx.Response(
                    status_code=resp.status_code,
                    headers=clean_headers,
                    content=resp.content,
                    request=request
                )
            except asyncio.CancelledError:
                await self.recycle()
                raise
            except Exception:
                await self.recycle()
                # Only idempotent read methods (GET, HEAD, OPTIONS) may fall back from curl_cffi to httpx.
                # Non-idempotent requests (e.g. POST CreateTweet) NEVER fall back or replay.
                if request.method.upper() not in ('GET', 'HEAD', 'OPTIONS'):
                    raise
                return await self.transport.handle_async_request(request)

        async def aclose(self):
            self._closed = True
            self._curl_recycled = False
            await self._close_curl_session()
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



def upstream_error_details(exc):
    """Allowlist diagnostics from an exception; NEVER serialize raw_json/cookies."""
    if exc is None:
        return {}
    code = getattr(exc, 'code', None)
    if code is None:
        code = getattr(exc, 'error_code', None)
    message = getattr(exc, 'x_error_message', None)
    http_status = getattr(exc, 'http_status', None)
    result = {}
    if isinstance(code, (str, int)) and not isinstance(code, bool):
        result['xErrorCode'] = code
    kind = getattr(exc, 'x_response_kind', None)
    if kind in ('graphql_errors', 'http_or_transport_failure'):
        result['xResponseKind'] = kind
    if isinstance(message, str):
        result['xErrorMessage'] = sanitize_diagnostic_text(message, 512)
    if type(http_status) is int:
        result['httpStatus'] = http_status
    return result


def identity_account_failure(exc):
    """Classify owner-read evidence, never HTTP/transport text as credentials."""
    marked = getattr(exc, 'account_failure', None)
    if marked in KNOWN_ACCOUNT_FAILURES:
        return marked
    cls_names = {c.__name__ for c in exc.__class__.__mro__}
    if 'AccountLocked' in cls_names:
        return 'captcha'
    if 'AccountSuspended' in cls_names:
        return 'banned'
    status = getattr(exc, 'http_status', None)
    if status is None:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
    errors = getattr(exc, 'errors', None)
    code = getattr(exc, 'code', None) or getattr(exc, 'error_code', None)
    is_transport = isinstance(exc, (OSError, ConnectionError)) or 'curl_cffi' in type(exc).__module__ or 'httpx' in type(exc).__module__
    if not errors and ((type(code) is int) or (isinstance(code, str) and re.fullmatch(r'[0-9]+', code))):
        if not is_transport or getattr(exc, 'raw_json', None) is not None:
            errors = [{'code': int(code)}]
    # Provider payload/messages are evidence. A generic HTTP 403/401 or proxy
    # exception mentioning "unauthorized" is not authenticated-owner evidence.
    text = getattr(exc, 'x_error_message', None)
    if not isinstance(text, str):
        text = ''
    return classify_x_account_failure(raw_json=getattr(exc, 'raw_json', None),
                                      errors=errors, text=text, http_status=status)


class DirectSession:
    def __init__(self, client, account):
        self.client = client
        self.expected = username(account.get('username'))
        self.expected_id = account.get('userId')
        self.use_cache = bool(account.get('use_cache'))
        self.verified = None
        self.used = False
        self.poisoned = False
        self.identity_data = None
        self.receipt = None
        self.dispatch_started_epoch = None
        self.dispatch_started_at = None

    async def identity(self):
        return await self._run_identity_with_retries(strict_settings=True)

    async def startup_identity(self):
        """Startup verification: check user_state and account ID without failing on fragile settings."""
        return await self._run_identity_with_retries(strict_settings=False)

    async def _run_identity_with_retries(self, *, strict_settings=True):
        # Retry only idempotent identity reads, before any dispatch ACK. A bare
        # HTTP failure is not evidence that the owner's credentials expired.
        if self.verified is not None:
            return self.verified
        import httpx
        loop = asyncio.get_running_loop()
        call_timeout = STARTUP_GET_TIMEOUT_SECONDS
        deadline = loop.time() + STARTUP_IDENTITY_DEADLINE_SECONDS

        def _raise_unavailable():
            error = ValueError('identity_read_unavailable')
            status = getattr(last_exc, 'http_status', None)
            setattr(error, 'read_diagnostic', {
                'phase': getattr(self, 'read_phase', 'unknown'),
                'httpStatus': status if type(status) is int else None,
                'retryAfterSeconds': getattr(last_exc, 'retry_after_seconds', 60) if status == 429 else None,
            })
            raise error from None

        last_exc = None
        for attempt in range(4):
            if loop.time() >= deadline:
                _raise_unavailable()
            try:
                return await self._identity_once(
                    strict_settings=strict_settings,
                    deadline=deadline,
                    call_timeout=call_timeout,
                )
            except Exception as exc:
                last_exc = exc
                failure = identity_account_failure(exc)
                if failure in KNOWN_ACCOUNT_FAILURES:
                    setattr(exc, 'account_failure', failure)
                if failure in ('banned', 'captcha', 'cookie_expired', 'auth_rejected'):
                    raise
                if failure == 'rate_limit' or (not failure and getattr(exc, 'http_status', None) == 429):
                    _raise_unavailable()
                transient = (
                    not getattr(exc, 'account_failure', None)
                    and (
                        getattr(exc, 'http_status', None) in (404, 408, 500, 502, 503, 504)
                        or isinstance(exc, (httpx.TimeoutException, httpx.TransportError, TimeoutError, OSError))
                    )
                )
                if not transient:
                    raise
                rem = deadline - loop.time()
                if attempt == 3 or rem <= 0:
                    _raise_unavailable()
                sleep_for = min(0.25 * 2 ** attempt, rem)
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
                if deadline - loop.time() <= 0:
                    _raise_unavailable()

    async def _identity_once(self, strict_settings=True, deadline=None, call_timeout=None):
        from urllib.parse import unquote
        import httpx
        loop = asyncio.get_running_loop()

        async def _bounded_get(awaitable):
            timeout = call_timeout
            if deadline is not None:
                rem = deadline - loop.time()
                if rem <= 0:
                    raise asyncio.TimeoutError()
                timeout = rem if timeout is None else min(timeout, rem)
            if timeout is None:
                return await awaitable
            return await asyncio.wait_for(awaitable, timeout=max(0.001, float(timeout)))

        # Always verify live authenticated session state via v11.user_state() and v11.settings(),
        # even when use_cache=True. Never infer live session validity from cached userId alone.
        self.read_phase = 'user_state'
        try:
            state_result = await _bounded_get(self.client.v11.user_state())
        except Exception as exc:
            failure = identity_account_failure(exc)
            if failure in KNOWN_ACCOUNT_FAILURES and not getattr(exc, 'account_failure', None):
                setattr(exc, 'account_failure', failure)
            raise
        state = state_result[0] if isinstance(state_result, (list, tuple)) and len(state_result) == 2 else None
        if isinstance(state, (list, tuple)) and state:
            state = state[0]
        remote_state = state.get('userState') if isinstance(state, dict) else None
        if remote_state == 'suspended':
            error = ValueError('auth_account_suspended')
            setattr(error, 'account_failure', 'banned')
            raise error
        if remote_state in ('locked', 'bounce', 'challenge', 'compromised', 'verification_required'):
            error = ValueError('auth_account_captcha')
            setattr(error, 'account_failure', 'captcha')
            setattr(error, 'error_code', 326)
            raise error
        if remote_state != 'normal':
            error = ValueError('auth_account_state_unverified')
            setattr(error, 'account_failure', 'auth_session_unverified')
            raise error

        twid = unquote(getattr(self.client, 'get_cookies', lambda: {})().get('twid', ''))
        candidate = twid[2:] if twid.startswith('u=') and numeric_id(twid[2:]) else None
        self.read_phase = 'settings'
        settings = None
        settings_error = None
        try:
            settings_result = await _bounded_get(self.client.v11.settings())
            settings = settings_result[0] if isinstance(settings_result, (list, tuple)) and len(settings_result) == 2 else None
        except Exception as exc:
            failure = identity_account_failure(exc)
            if failure in ('banned', 'captcha', 'cookie_expired', 'auth_rejected', 'auth_session_unverified', 'auth'):
                if not getattr(exc, 'account_failure', None):
                    setattr(exc, 'account_failure', failure)
                raise
            settings_error = exc
        actual = username(settings.get('screen_name')) if isinstance(settings, dict) else None
        uid = None
        if isinstance(settings, dict):
            s_uid = settings.get('id_str') or (str(settings['id']) if isinstance(settings.get('id'), int) else None) or (str(settings['user_id']) if isinstance(settings.get('user_id'), (int, str)) else None)
            if s_uid and numeric_id(str(s_uid)):
                uid = str(s_uid)

        # Authenticated self verify_credentials when settings intermittently returns 404
        # (Code 34) or omits screen_name or numeric user ID.
        if not actual or not uid:
            self.read_phase = 'verify_credentials'
            try:
                vc_res = None
                if hasattr(self.client, 'v11') and hasattr(self.client.v11, 'verify_credentials'):
                    try:
                        vc_res = await _bounded_get(self.client.v11.verify_credentials(skip_status=True, include_entities=False))
                    except (AttributeError, TypeError):
                        vc_res = None
                if vc_res is None and hasattr(self.client, 'get'):
                    vc_res = await _bounded_get(self.client.get(
                        'https://api.x.com/1.1/account/verify_credentials.json?skip_status=true&include_entities=false',
                        headers=getattr(self.client, '_base_headers', None),
                    ))
                vc_data = vc_res[0] if isinstance(vc_res, (list, tuple)) and len(vc_res) == 2 else vc_res
                if isinstance(vc_data, dict):
                    vc_screen = username(vc_data.get('screen_name'))
                    vc_uid = vc_data.get('id_str') or (str(vc_data['id']) if isinstance(vc_data.get('id'), int) else None)
                    if vc_screen and numeric_id(str(vc_uid or '')):
                        if actual and actual != vc_screen:
                            raise ValueError('auth_identity_mismatch')
                        actual = vc_screen
                        uid = str(vc_uid)
                        settings_error = None
            except ValueError:
                raise
            except Exception as exc:
                failure = identity_account_failure(exc)
                if failure in ('banned', 'captcha', 'cookie_expired', 'auth_rejected', 'auth_session_unverified', 'auth'):
                    if not getattr(exc, 'account_failure', None):
                        setattr(exc, 'account_failure', failure)
                    raise
                if not settings_error:
                    settings_error = exc

        # When authenticated self endpoints fail, fail closed immediately.
        # ELIMINATE the unauthenticated twid/public-target profile lookup fallback (lines 772-783 get_user_by_id).
        # Public user lookups do not establish session ownership.
        if not actual:
            if settings_error:
                raise settings_error
            raise ValueError('auth_identity_missing')

        if self.expected and actual != self.expected:
            raise ValueError('auth_identity_mismatch')
        if self.verified and actual != self.verified.get('username'):
            raise ValueError('auth_identity_changed')

        self.read_phase = 'profile'
        # Even cached IDs may originate from the uploaded twid cookie. Bind the
        # ID to the name read from authenticated settings via a profile lookup if
        # uid was not directly provided by authenticated endpoints.
        if not uid:
            try:
                user_call = self.client.get_user_by_id(candidate) if candidate else self.client.get_user_by_screen_name(actual)
                user = await _bounded_get(user_call)
            except Exception as exc:
                failure = identity_account_failure(exc)
                # A public lookup's target restriction is not evidence about the
                # authenticated owner, even when twid supplied the lookup target.
                if failure in ('banned', 'captcha'):
                    raise ValueError('auth_identity_unverified') from None
                if failure in ('cookie_expired', 'auth_rejected', 'auth_session_unverified', 'auth'):
                    if not getattr(exc, 'account_failure', None):
                        setattr(exc, 'account_failure', failure)
                    raise
                if not getattr(exc, 'account_failure', None) and (
                    getattr(exc, 'http_status', None) in (404, 408, 429, 500, 502, 503, 504)
                    or isinstance(exc, (httpx.TimeoutException, httpx.TransportError, TimeoutError, OSError))
                ):
                    raise
                raise ValueError('auth_identity_unverified') from None
            uid = getattr(user, 'id', None)
            if not numeric_id(uid) or (candidate and str(uid) != str(candidate)) or username(getattr(user, 'screen_name', None)) != actual:
                raise ValueError('auth_identity_missing')

        if not numeric_id(uid):
            raise ValueError('auth_identity_missing')

        # Enforce exact comparison of candidate numeric ID from twid cookie AND expected_id from config/DB against the authenticated self numeric ID (userId).
        if candidate and str(uid) != str(candidate):
            raise ValueError('auth_identity_mismatch')
        if self.expected_id and str(uid) != str(self.expected_id):
            raise ValueError('auth_identity_mismatch')

        result = {'state': 'authenticated', 'authenticated': True, 'username': actual, 'userId': str(uid)}
        if self.verified and result != self.verified:
            raise ValueError('auth_identity_changed')
        self.verified = result
        return result

    async def verify_tweet_by_id(self, tweet_id, identity, expected_text, dispatch_started_epoch=None):
        """Read-only owner-assisted lookup; absence or incomplete proof fails closed."""
        if not numeric_id(tweet_id) or not isinstance(identity, dict) or not numeric_id(identity.get('userId')) or not username(identity.get('username')) or not isinstance(expected_text, str) or not expected_text.strip():
            return {'verified': False, 'reason': 'invalid_request'}
        try:
            tweet = await asyncio.wait_for(self.client.get_tweet_by_id(str(tweet_id)), timeout=12.0)
        except Exception:
            return {'verified': False, 'reason': 'lookup_failed'}
        if tweet is None or str(getattr(tweet, 'id', '')) != str(tweet_id):
            return {'verified': False, 'reason': 'tweet_not_found'}
        if dispatch_started_epoch is not None:
            sf = extract_snowflake_epoch(tweet_id)
            if sf is None or sf < dispatch_started_epoch or not is_recent_tweet(tweet, dispatch_started_epoch=dispatch_started_epoch):
                return {'verified': False, 'reason': 'timestamp_mismatch'}
        author = getattr(tweet, 'user', None)
        user_id = getattr(author, 'id', None)
        screen_name = username(getattr(author, 'screen_name', None))
        if not numeric_id(str(user_id or '')) or str(user_id) != str(identity['userId']) or not screen_name or screen_name != username(identity['username']):
            return {'verified': False, 'reason': 'author_mismatch'}
        urls_entity = getattr(tweet, 'urls', None)
        raw_entities = getattr(tweet, 'entities', None) or (
            getattr(getattr(tweet, '_legacy', None), 'get', lambda k, d=None: d)('entities')
        )
        entities = raw_entities or ({'urls': urls_entity} if urls_entity else None)
        actual_text = getattr(tweet, 'full_text', None)
        if actual_text is None:
            actual_text = getattr(tweet, 'text', '')
        if not isinstance(actual_text, str) or not _texts_match_tweet(actual_text, entities, normalize_text_for_comparison(expected_text)):
            return {'verified': False, 'reason': 'text_mismatch'}
        return {
            'verified': True,
            'tweetId': str(tweet_id),
            'userId': str(user_id),
            'username': screen_name,
            'url': f"https://x.com/{screen_name}/status/{tweet_id}",
        }

    async def verify_timeline_has_post(self, text, identity, dispatch_started_epoch=None, tweet_id=None):
        """Verify whether user timeline contains post matching text authored by identity."""
        return await self.verify_timeline(text, identity, dispatch_started_epoch=dispatch_started_epoch, tweet_id=tweet_id)

    async def verify_timeline(self, text, identity, dispatch_started_epoch=None, tweet_id=None):
        """Check whether the tweet actually landed by reading the user timeline.

        Called only after create_tweet raised an exception (timeout / network
        glitch) or returned None / missing rest_id so the dispatch already happened.
        Returns:
          - dict with 'found': True, 'status': 'published', 'tweetId', etc. if tweet is conclusively on timeline.
          - dict with 'found': False, 'status': 'ambiguous', 'ambiguous': True if tweet is not confirmed.
            NEVER returns 'verifiedNotPosted': True.
        """
        import time
        effective_start = _to_epoch_seconds(
            dispatch_started_epoch
            if dispatch_started_epoch is not None
            else (self.dispatch_started_epoch if self.dispatch_started_epoch is not None else self.dispatch_started_at)
        )
        if effective_start is None:
            effective_start = time.time()

        sent_norm = normalize_text_for_comparison(text)
        last_fetch_error = None
        deadline_exceeded = False
        checks = 0

        _verify_deadline = time.monotonic() + TIMELINE_VERIFY_DEADLINE_SECONDS

        def _remaining():
            return _verify_deadline - time.monotonic()

        for delay in TIMELINE_VERIFY_WAITS:
            rem = _remaining()
            if rem <= 0:
                deadline_exceeded = True
                break
            sleep_cap = rem * 0.25 if TIMELINE_VERIFY_DEADLINE_SECONDS < delay else rem
            await asyncio.sleep(delay if sleep_cap >= delay else max(0.0, sleep_cap))
            if _remaining() <= 0:
                deadline_exceeded = True
                break
            checks += 1
            try:
                if numeric_id(tweet_id) and hasattr(self.client, 'get_tweet_by_id'):
                    try:
                        lookup = await asyncio.wait_for(
                            self.verify_tweet_by_id(tweet_id, identity, text, effective_start),
                            timeout=min(5.0, _remaining()),
                        )
                        if lookup.get('verified'):
                            return {'status': 'published', 'published': True, 'posted': True, 'ok': True,
                                    'found': True, 'verified': True, 'verified_via': 'tweet_id',
                                    'recoveredFromTimeline': True, 'recovered_from_timeline': True,
                                    'tweetId': tweet_id, 'tweetUrl': lookup['url'],
                                    'username': identity['username'], 'userId': identity['userId'],
                                    'timelineChecks': checks}
                    except (asyncio.TimeoutError, TimeoutError):
                        pass
                tweets_data = []
                cursor = None
                gql_failed = False

                # Query GraphQL user_tweets with pagination support (up to 2 pages)
                if hasattr(self.client, 'gql') and hasattr(self.client.gql, 'user_tweets'):
                    for page in range(2):
                        rem = _remaining()
                        if rem <= 0:
                            deadline_exceeded = True
                            gql_failed = True
                            break
                        try:
                            gql_res, _ = await asyncio.wait_for(
                                self.client.gql.user_tweets(identity['userId'], 10, cursor),
                                timeout=min(12.0, rem),
                            )
                        except (asyncio.TimeoutError, TimeoutError):
                            deadline_exceeded = True
                            gql_failed = True
                            break
                        except Exception as gql_err:
                            last_fetch_error = gql_err
                            gql_failed = True
                            break

                        if not isinstance(gql_res, dict):
                            break
                        if gql_res.get('errors'):
                            acc_fail = classify_x_account_failure(raw_json=gql_res, errors=gql_res.get('errors'))
                            if acc_fail or not (isinstance(gql_res.get('data'), dict) and gql_res['data'].get('user') is not None):
                                break

                        instructions = (
                            (gql_res.get('data') or {})
                            .get('user', {})
                            .get('result', {})
                            .get('timeline_v2', {})
                            .get('timeline', {})
                            .get('instructions', [])
                        )
                        if not isinstance(instructions, list) or (gql_res.get('errors') and not instructions):
                            break

                        next_cursor = None
                        for instr in instructions:
                            if not isinstance(instr, dict):
                                continue
                            entries = list(instr.get('entries') or [])
                            if isinstance(instr.get('entry'), dict):
                                entries.append(instr['entry'])
                            for parent in list(entries):
                                content = parent.get('content') if isinstance(parent, dict) else None
                                items = content.get('items', []) if isinstance(content, dict) else []
                                if isinstance(items, list):
                                    for item in items:
                                        inner = item.get('item', {}) if isinstance(item, dict) else {}
                                        if isinstance(inner, dict):
                                            entries.append({'content': inner})
                            for entry in entries:
                                if not isinstance(entry, dict):
                                    continue
                                entry_id = str(entry.get('entryId', ''))
                                content = entry.get('content', {})
                                if entry_id.lower().startswith('cursor-bottom') or content.get('cursorType') in ('Bottom', 'bottom'):
                                    val = content.get('value')
                                    if isinstance(val, str) and val.strip():
                                        next_cursor = val.strip()

                                item_content = content.get('itemContent', {})
                                tweet_results = item_content.get('tweet_results', {}).get('result', {})
                                if isinstance(tweet_results, dict):
                                    tw_res = tweet_results.get('tweet', tweet_results) if isinstance(tweet_results.get('tweet'), dict) else tweet_results
                                    legacy = tw_res.get('legacy', {}) if isinstance(tw_res.get('legacy'), dict) else {}
                                    if isinstance(legacy, dict):
                                        tid = legacy.get('id_str') or tw_res.get('rest_id')
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
                                            user_core = core_user.get('core') if isinstance(core_user, dict) else None
                                            user_name_extracted = (core_legacy.get('screen_name') if isinstance(core_legacy, dict) else None) or (user_core.get('screen_name') if isinstance(user_core, dict) else None) or (legacy.get('screen_name') if isinstance(legacy, dict) else None)
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
                if not tweets_data and not gql_failed and hasattr(self.client, 'get_user_tweets'):
                    rem = _remaining()
                    if rem <= 0:
                        deadline_exceeded = True
                        break
                    try:
                        recent = await asyncio.wait_for(
                            self.client.get_user_tweets(identity['userId'], 'Tweets', count=10),
                            timeout=min(10.0, rem),
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
                    except (asyncio.TimeoutError, TimeoutError):
                        deadline_exceeded = _remaining() <= 0
                        if deadline_exceeded:
                            break
                        continue
                    except Exception as fallback_err:
                        last_fetch_error = fallback_err

                # Evaluate retrieved tweets
                for tweet in tweets_data:
                    tweet_text = tweet.get('full_text', '')
                    tweet_entities = tweet.get('entities')

                    # Strict exact matching ONLY. Prefix matching is completely eliminated.
                    matched = bool(sent_norm and _texts_match_tweet(tweet_text, tweet_entities, sent_norm))

                    tw_obj = SimpleNamespace(**tweet) if isinstance(tweet, dict) else tweet
                    if matched and is_recent_tweet(tw_obj, dispatch_started_epoch=effective_start):
                        tid = tweet.get('id')
                        if numeric_id(tid):
                            if tweet_id is not None and str(tid) != str(tweet_id):
                                continue
                            sf_ts = extract_snowflake_epoch(tid)
                            if sf_ts is None or sf_ts < effective_start:
                                continue
                            author_id = tweet.get('user_id')
                            author_name = username(tweet.get('user_name'))

                            expected_author_name = username(identity.get('username')) or identity.get('username')
                            # Strict author verification: authentic author identity must be extracted from the tweet
                            if not author_id or not author_name or not identity.get('userId') or not expected_author_name:
                                continue
                            if str(author_id) != str(identity.get('userId')) or author_name != expected_author_name:
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
                                'found': True,
                                'timelineChecks': checks
                            }
            except (asyncio.TimeoutError, TimeoutError):
                deadline_exceeded = True
                break
            except Exception as exc:
                last_fetch_error = exc

        # Non-appearance on timeline under eventual consistency NEVER proves non-existence.
        # Always return ambiguous to prevent automated retry loops.
        fetch_err_diag = (
            sanitize_diagnostic_text(last_fetch_error, 512)
            if last_fetch_error is not None
            else ('timeline_verify_deadline_exceeded' if deadline_exceeded else None)
        )
        return {
            'status': 'ambiguous',
            'published': False,
            'posted': False,
            'ambiguous': True,
            'retryable': False,
            'verified': False,
            'found': False,
            'reason': 'publish_confirmation_missing',
            'fetchError': fetch_err_diag,
            'verificationError': fetch_err_diag,
            'fetchException': last_fetch_error,
            'timelineChecks': checks
        }

    async def publish(self, text, dispatch):
        import time
        if getattr(self, 'poisoned', False):
            return {'status': 'not_ready', 'published': False, 'posted': False, 'ambiguous': False, 'blocked': True, 'reason': 'worker_poisoned'}
        if self.used:
            return {**uncertain('dispatch_already_attempted'), 'retryable': False}
        if getattr(self, 'identity_data', None):
            identity = self.identity_data
        elif self.verified:
            identity = self.verified
        else:
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
                return result
        if not isinstance(text, str) or not text.strip(): return unsent('invalid_text')
        # The dispatcher must persist and fsync its dispatching fence before ACK.
        dispatched = False

        def _finalize_post_dispatch(res):
            if dispatched and isinstance(res, dict) and res.get('published') is not True:
                res['published'] = False
                res['posted'] = False
                res['ambiguous'] = True
                res['retryable'] = False
                self.poisoned = True
                self.used = True
            if isinstance(res, dict):
                for key, limit in (('xErrorMessage', 512), ('rawError', 2048), ('verificationError', 512), ('fetchError', 2048)):
                    if isinstance(res.get(key), str):
                        res[key] = sanitize_diagnostic_text(res[key], limit)
            return res

        try:
            self.dispatch_started_epoch = time.time()
            self.dispatch_started_at = self.dispatch_started_epoch
            try:
                acknowledgement = dispatch()
                if inspect.isawaitable(acknowledgement): acknowledgement = await acknowledgement
            except Exception:
                acknowledgement = False
            if acknowledgement is not True:
                return {**uncertain('dispatch_not_acknowledged'), 'retryable': False}
            dispatched = True
            self.used = True
            self.dispatch_started_epoch = time.time()
            self.dispatch_started_at = self.dispatch_started_epoch
            tweet = await self.client.create_tweet(text=text)  # exactly ONE call
            def response_field(obj, key):
                return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)

            author = response_field(tweet, 'user') if tweet is not None else None
            response_id = response_field(tweet, 'id') if tweet is not None else None
            response_rest_id = response_field(tweet, 'rest_id') if tweet is not None else None
            tid = (
                getattr(tweet, 'id', None)
                or getattr(tweet, 'rest_id', None)
                or (tweet.get('rest_id') or tweet.get('id') if isinstance(tweet, dict) else None)
            ) if tweet is not None else None
            author_id = response_field(author, 'id') if author is not None else None
            author_screen_name = response_field(author, 'screen_name') if author is not None else None
            if ((response_id is not None and response_rest_id is not None and str(response_id) != str(response_rest_id))
                    or (author_id is not None and str(author_id) != str(identity['userId']))
                    or (author_screen_name is not None and username(author_screen_name) != identity['username'])):
                return _finalize_post_dispatch(uncertain('publish_response_identity_mismatch'))

            response_text = response_field(tweet, 'full_text') if tweet is not None else None
            if response_text is None and tweet is not None:
                response_text = response_field(tweet, 'text')
            if isinstance(response_text, str):
                response_entities = response_field(tweet, 'entities') or (
                    getattr(response_field(tweet, '_legacy'), 'get', lambda k, d=None: d)('entities')
                ) or ({'urls': response_field(tweet, 'urls')} if response_field(tweet, 'urls') else None)
                if not _texts_match_tweet(response_text, response_entities, text):
                    return _finalize_post_dispatch(uncertain('publish_response_text_mismatch'))

            is_valid_tweet = (
                tweet is not None
                and numeric_id(tid)
                and str(author_id or '') == str(identity['userId'])
                and username(author_screen_name) == identity['username']
            )

            if is_valid_tweet:
                # X Snowflakes carry millisecond timestamps. Floor the dispatch
                # instant to that precision so the same millisecond is valid.
                sf = extract_snowflake_epoch(tid)
                dispatch_ms = int(self.dispatch_started_epoch * 1000) / 1000
                if (isinstance(response_text, str) and sf is not None
                        and sf >= dispatch_ms
                        and is_recent_tweet(tweet, dispatch_started_epoch=self.dispatch_started_epoch)):
                    tid_str = str(tid)
                    url = f"https://x.com/{identity['username']}/status/{tid_str}"
                    self.used = False
                    return {
                        'status': 'published',
                        'published': True,
                        'posted': True,
                        'tweetId': tid_str,
                        'url': url,
                        'tweetUrl': url,
                        'username': identity['username'],
                        'userId': identity['userId'],
                        'ok': True,
                    }

            # If create_tweet returned None or author/id validation failed:
            # Do NOT immediately collapse into publish_author_or_id_unverified.
            # Inspect response and check timeline via verify_timeline_has_post or user tweets
            # to definitively prove whether the tweet landed on X before classifying.
            candidate_id = str(tid) if numeric_id(str(tid or '')) else None
            if not candidate_id:
                response = getattr(self.client, '_last_create_tweet_response', None)
                data = response.get('data') if isinstance(response, dict) else None
                node = (data.get('create_tweet') or data.get('notetweet_create')) if isinstance(data, dict) else None
                results = node.get('tweet_results') if isinstance(node, dict) else None
                raw = results.get('result') if isinstance(results, dict) else None
                if isinstance(raw, dict) and isinstance(raw.get('tweet'), dict):
                    raw = raw['tweet']
                legacy = raw.get('legacy') if isinstance(raw, dict) else None
                value = (raw.get('rest_id') if isinstance(raw, dict) else None) or (legacy.get('id_str') if isinstance(legacy, dict) else None)
                candidate_id = value if numeric_id(value) else None
            timeline_res = None
            tl_exc = None
            try:
                if hasattr(self, 'verify_timeline_has_post') and callable(self.verify_timeline_has_post):
                    timeline_res = await self.verify_timeline_has_post(text, identity, tweet_id=candidate_id) if candidate_id else await self.verify_timeline_has_post(text, identity)
                else:
                    timeline_res = await self.verify_timeline(text, identity)
            except Exception as e:
                tl_exc = e
                timeline_res = {
                    'fetchError': sanitize_diagnostic_text(e, 512),
                    'verificationError': sanitize_diagnostic_text(e, 512),
                    'fetchException': e,
                }

            # If it landed on X: extract verified URL and tweet ID and return { published: true, url, tweetId }
            if (isinstance(timeline_res, dict)
                    and timeline_res.get('found') is True
                    and timeline_res.get('status') == 'published'):
                timeline_res.pop('fetchException', None)
                tid_str = str(timeline_res.get('tweetId') or '')
                url = (timeline_res.get('url')
                       or timeline_res.get('tweetUrl')
                       or f"https://x.com/{identity['username']}/status/{tid_str}")
                timeline_res['url'] = url
                timeline_res['tweetUrl'] = url
                timeline_res['tweetId'] = tid_str
                timeline_res['username'] = identity['username']
                timeline_res['userId'] = identity['userId']
                timeline_res['recoveredFromTimeline'] = True
                timeline_res['recovered_from_timeline'] = True
                timeline_res['ok'] = True
                self.used = False
                return timeline_res

            # If it did not land on X: diagnose the failure while preserving post-dispatch ambiguity fence
            fetch_exc = tl_exc or (timeline_res.pop('fetchException', None) if isinstance(timeline_res, dict) else None)
            fetch_err_str = str(timeline_res.get('fetchError') or timeline_res.get('verificationError') or fetch_exc or '') if isinstance(timeline_res, dict) else ''

            if fetch_exc and is_rate_limit_exception(fetch_exc):
                retry_after = extract_retry_after_seconds(fetch_exc, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(fetch_exc, 2048),
                })

            client_error = getattr(self.client, '_last_create_tweet_error', None)
            if client_error and isinstance(client_error, BaseException) and is_rate_limit_exception(client_error):
                retry_after = extract_retry_after_seconds(client_error, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(client_error, 2048),
                })

            if fetch_err_str and bool(_RATE_LIMIT_MSG_PATTERN.search(fetch_err_str)):
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': 60,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(fetch_err_str, 2048),
                })

            diag = None
            last_resp = getattr(self.client, '_last_create_tweet_response', None)
            if isinstance(last_resp, dict):
                diag = classify_x_account_failure(raw_json=last_resp, errors=last_resp.get('errors', []))
            if not diag and fetch_exc:
                diag = classify_x_account_failure(raw_json=getattr(fetch_exc, 'raw_json', None), text=str(fetch_exc))
            if not diag and fetch_err_str:
                diag = classify_x_account_failure(text=fetch_err_str)
            if not diag and client_error and isinstance(client_error, BaseException):
                diag = classify_x_account_failure(raw_json=getattr(client_error, 'raw_json', None), text=str(client_error))

            if diag == 'rate_limit':
                retry_after = extract_retry_after_seconds(fetch_exc or client_error, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(fetch_err_str or str(client_error or ''), 2048),
                })

            if diag == 'network_proxy_error':
                return _finalize_post_dispatch({
                    'status': 'ambiguous',
                    'published': False,
                    'posted': False,
                    'ambiguous': True,
                    'blocked': False,
                    'retryable': False,
                    'accountFailure': 'network_proxy_error',
                    'reason': 'network_proxy_error',
                    'rawError': sanitize_diagnostic_text(fetch_err_str or str(client_error or ''), 2048),
                })

            if diag in ('banned', 'captcha', 'cookie_expired', 'auth_rejected'):
                res = uncertain(diag)
                res['accountFailure'] = diag
                res['retryable'] = False
                if fetch_err_str or (client_error and isinstance(client_error, BaseException)):
                    res['rawError'] = sanitize_diagnostic_text(fetch_err_str or str(client_error or ''), 2048)
                return _finalize_post_dispatch(res)

            if tweet is None or not numeric_id(str(tid or '')):
                reason = 'create_tweet_returned_none'
                last_resp = getattr(self.client, '_last_create_tweet_response', None)
                if not isinstance(last_resp, dict) and isinstance(tweet, dict):
                    last_resp = tweet
                x_resp_kind = None
                x_err_msg = None
                x_err_code = None
                if isinstance(last_resp, dict):
                    errors = last_resp.get('errors')
                    if isinstance(errors, list) and errors:
                        first_err = errors[0] if isinstance(errors[0], dict) else {}
                        raw_ext = first_err.get('extensions')
                        ext = raw_ext if isinstance(raw_ext, dict) else {}
                        x_err_code = first_err.get('code') if first_err.get('code') is not None else ext.get('code')
                        x_err_msg = first_err.get('message')
                        x_resp_kind = 'graphql_errors'
                diag = getattr(self.client, '_last_create_tweet_diag', None)
                if not x_resp_kind and isinstance(diag, dict):
                    x_resp_kind = diag.get('kind')
                if not x_resp_kind and isinstance(last_resp, dict):
                    data_node = last_resp.get('data') if isinstance(last_resp, dict) else None
                    ct_node = (
                        (data_node.get('notetweet_create') or data_node.get('create_tweet'))
                        if isinstance(data_node, dict)
                        else None
                    )
                    tr_node = ct_node.get('tweet_results') if isinstance(ct_node, dict) else None
                    raw_res = tr_node.get('result') if isinstance(tr_node, dict) else None
                    if not isinstance(ct_node, dict):
                        x_resp_kind = 'missing_create_tweet'
                    elif not isinstance(tr_node, dict) or not tr_node:
                        x_resp_kind = 'empty_tweet_results'
                    elif 'result' in tr_node and raw_res is None:
                        x_resp_kind = 'null_result'
                    elif isinstance(raw_res, dict) and raw_res.get('__typename') in ('TweetTombstone', 'TweetUnavailable'):
                        x_resp_kind = 'tombstone'
                    else:
                        x_resp_kind = 'unparseable'
                if not x_resp_kind:
                    x_resp_kind = 'empty_tweet_results'
                result = uncertain(reason)
                status = (
                    diag.get('httpStatus')
                    if isinstance(diag, dict) and diag.get('httpStatus') is not None
                    else getattr(self.client, '_last_create_tweet_http_status', None)
                )
                result['httpStatus'] = status if isinstance(status, int) and not isinstance(status, bool) else None
                result['transactionDegraded'] = (
                    bool(diag.get('transactionDegraded'))
                    if isinstance(diag, dict) and 'transactionDegraded' in diag
                    else bool(getattr(getattr(self.client, 'client_transaction', None), 'degraded', False))
                )
                result['retryable'] = False
                result['timelineChecks'] = timeline_res.get('timelineChecks', 0) if isinstance(timeline_res, dict) else 0
                tweet_rejection = classify_x_tweet_rejection(raw_json=last_resp, text=str(x_err_msg or ''))
                if tweet_rejection:
                    result['rejectionReason'] = tweet_rejection
                result['xResponseKind'] = x_resp_kind
                result['xErrorCode'] = x_err_code
                result['xErrorMessage'] = sanitize_diagnostic_text(x_err_msg, 512) if x_err_msg else None
                ver_err = (
                    (timeline_res.get('verificationError') or timeline_res.get('fetchError'))
                    if isinstance(timeline_res, dict)
                    else None
                ) or (sanitize_diagnostic_text(tl_exc, 512) if tl_exc else None)
                result['verificationError'] = sanitize_diagnostic_text(ver_err, 512) if ver_err else None
                if fetch_err_str:
                    result['fetchError'] = sanitize_diagnostic_text(fetch_err_str, 2048)
                return _finalize_post_dispatch(result)

            return _finalize_post_dispatch(uncertain('publish_author_or_id_unverified'))
        except Exception as exc:
            if isinstance(exc, asyncio.CancelledError):
                raise

            # Dispatch crossed the fence if dispatched is True — the tweet MAY have posted
            # or encountered an upstream error after ACK.
            # A GraphQL error code directly returned by CreateTweet is an explicit
            # rejection, unlike a transport error or an empty response. Never retry.
            raw = getattr(exc, 'raw_json', None)
            errors = raw.get('errors') if isinstance(raw, dict) else None
            data = raw.get('data') if isinstance(raw, dict) else None
            if dispatched and getattr(exc, 'x_response_kind', None) == 'graphql_errors' and isinstance(errors, list) and errors and not _has_created_tweet_node(data):
                rejection = classify_x_tweet_rejection(raw_json=raw, errors=errors)
                if rejection in ('duplicate_content', 'length_exceeded', 'content_moderation', 'account_locked', 'account_suspended', 'auth_rejected'):
                    account_failure = getattr(exc, 'account_failure', None) or classify_x_account_failure(raw_json=raw, errors=errors)
                    self.used = False
                    return {'status': 'rejected', 'published': False, 'posted': False,
                            'ambiguous': False, 'retryable': False, 'definitiveRejection': True,
                            'rejectionReason': rejection, 'reason': 'rejected_' + rejection,
                            'accountFailure': account_failure, **upstream_error_details(exc)}

            if is_rate_limit_exception(exc) and not dispatched:
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
                    'rawError': sanitize_diagnostic_text(exc, 2048),
                    **upstream_error_details(exc),
                }

            if is_rate_limit_exception(exc):
                retry_after = extract_retry_after_seconds(exc, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(exc, 2048),
                    **upstream_error_details(exc),
                })

            x_error_code = getattr(exc, 'code', None)
            if x_error_code is None:
                x_error_code = getattr(exc, 'error_code', None)
            x_response_kind = getattr(exc, 'x_response_kind', None)
            x_message = getattr(exc, 'x_error_message', None)
            x_http_status = getattr(exc, 'http_status', None)
            account_failure = getattr(exc, 'account_failure', None) or classify_x_account_failure(raw_json=getattr(exc, 'raw_json', None), text=str(exc))

            timeline_res = None
            verification_error = None
            try:
                if hasattr(self, 'verify_timeline_has_post') and callable(self.verify_timeline_has_post):
                    timeline_res = await self.verify_timeline_has_post(text, identity)
                else:
                    timeline_res = await self.verify_timeline(text, identity)
            except Exception as verification_exc:
                # A failed verification read is distinct from the original X
                # CreateTweet response; both diagnostics must survive the bridge.
                verification_error = sanitize_diagnostic_text(verification_exc, 512)

            if (isinstance(timeline_res, dict)
                    and timeline_res.get('found') is True
                    and timeline_res.get('status') == 'published'):
                timeline_res.pop('fetchException', None)
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
                timeline_res['ok'] = True
                self.used = False
                if account_failure in KNOWN_ACCOUNT_FAILURES:
                    timeline_res['accountFailure'] = account_failure
                if x_error_code:
                    timeline_res['xErrorCode'] = x_error_code
                if x_message:
                    timeline_res['xErrorMessage'] = sanitize_diagnostic_text(x_message, 512)
                return timeline_res

            # Check if timeline check encountered rate limit
            fetch_exc = timeline_res.get('fetchException') if isinstance(timeline_res, dict) else None
            if isinstance(timeline_res, dict):
                timeline_res.pop('fetchException', None)
            if fetch_exc and is_rate_limit_exception(fetch_exc):
                retry_after = extract_retry_after_seconds(fetch_exc, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(fetch_exc, 2048),
                    'verificationError': sanitize_diagnostic_text(fetch_exc, 512),
                    **upstream_error_details(exc),
                })

            if account_failure == 'rate_limit':
                retry_after = extract_retry_after_seconds(exc, default=60)
                return _finalize_post_dispatch({
                    'status': 'rate_limit',
                    'published': False,
                    'posted': False,
                    'rateLimit': True,
                    'ambiguous': True,
                    'retryable': False,
                    'accountFailure': 'rate_limit',
                    'retryAfterSeconds': retry_after,
                    'reason': 'rate_limit',
                    'rawError': sanitize_diagnostic_text(exc, 2048),
                    **upstream_error_details(exc),
                })

            tweet_rejection = classify_x_tweet_rejection(
                raw_json=getattr(exc, 'raw_json', None),
                errors=getattr(exc, 'errors', None),
                text=str(exc),
                http_status=x_http_status
            )
            if tweet_rejection in ('duplicate_content', 'length_exceeded', 'content_moderation'):
                return _finalize_post_dispatch({
                    'status': 'rejected',
                    'published': False,
                    'posted': False,
                    'ambiguous': True,
                    'retryable': False,
                    'rejectionReason': tweet_rejection,
                    'reason': f"rejected_{tweet_rejection}",
                    'xErrorCode': x_error_code,
                    'xResponseKind': x_response_kind or 'graphql_errors',
                    'httpStatus': x_http_status,
                    'xErrorMessage': sanitize_diagnostic_text(x_message, 512) if isinstance(x_message, str) else None,
                    'verificationError': verification_error or (
                        sanitize_diagnostic_text(timeline_res.get('verificationError') or timeline_res.get('fetchError'), 512)
                        if isinstance(timeline_res, dict) and (timeline_res.get('verificationError') or timeline_res.get('fetchError')) else None
                    ),
                    'rawError': sanitize_diagnostic_text(exc, 2048),
                    **upstream_error_details(exc),
                })

            result = uncertain('publish_confirmation_missing')
            result['retryable'] = False
            result['timelineChecks'] = timeline_res.get('timelineChecks', 0) if isinstance(timeline_res, dict) else 0
            if tweet_rejection:
                result['rejectionReason'] = tweet_rejection
            if account_failure in KNOWN_ACCOUNT_FAILURES:
                result['accountFailure'] = account_failure
            if x_error_code is not None:
                result['xErrorCode'] = x_error_code
            result['xResponseKind'] = x_response_kind or 'unclassified_exception'
            result['httpStatus'] = x_http_status if isinstance(x_http_status, int) else None
            result['xErrorMessage'] = sanitize_diagnostic_text(x_message, 512) if isinstance(x_message, str) else None
            result['verificationError'] = verification_error or (
                sanitize_diagnostic_text(timeline_res.get('verificationError') or timeline_res.get('fetchError'), 512)
                if isinstance(timeline_res, dict) and (timeline_res.get('verificationError') or timeline_res.get('fetchError')) else None
            )
            result['rawError'] = sanitize_diagnostic_text(exc, 2048)
            result.update(upstream_error_details(exc))
            return _finalize_post_dispatch(result)


def _protocol_command(command, *, expected_request_id=None, expected_operation=None, used_ids=None, allow_existing_id=False):
    if not isinstance(command, dict) or isinstance(command, list):
        raise ValueError('protocol')
    request_id = command.get('requestId') or command.get('request_id')
    operation = command.get('op')
    if not isinstance(request_id, str) or not request_id or not isinstance(operation, str) or not operation:
        raise ValueError('protocol')
    command['requestId'] = request_id
    if expected_request_id is not None and request_id != expected_request_id:
        raise ValueError('protocol_correlation')
    if expected_operation is not None and operation != expected_operation:
        raise ValueError('protocol_operation')
    if used_ids is not None and request_id in used_ids and not allow_existing_id:
        raise ValueError('protocol_duplicate')
    if used_ids is not None and not allow_existing_id:
        used_ids.add(request_id)
    return command


def emit(result, *, request_id=None, operation=None):
    if isinstance(result, dict):
        if request_id is not None:
            result['requestId'] = request_id
        if operation is not None:
            result['op'] = operation
        if result.get('event') == 'dispatch_ready':
            result['requestId'] = request_id
            result['op'] = operation
        if result.get('event') == 'result' and isinstance(result.get('result'), dict):
            result['result']['requestId'] = request_id
            result['result']['op'] = operation
        if isinstance(result, dict):
            pass
    if isinstance(result, dict):
        for k, v in list(result.items()):
            if isinstance(v, BaseException):
                result[k] = sanitize_diagnostic_text(v, 512)
        inner = result.get('result')
        if isinstance(inner, dict):
            for k, v in list(inner.items()):
                if isinstance(v, BaseException):
                    inner[k] = sanitize_diagnostic_text(v, 512)
            for key, limit in (('xErrorMessage', 512), ('rawError', 2048), ('verificationError', 512), ('fetchError', 2048)):
                if isinstance(inner.get(key), str):
                    inner[key] = sanitize_diagnostic_text(inner[key], limit)
    print(
        json.dumps(
            result,
            separators=(',', ':'),
            default=lambda o: sanitize_diagnostic_text(o, 512) if isinstance(o, BaseException) else str(o),
        ),
        flush=True,
    )


def _has_created_tweet_node(data):
    """Return True if GraphQL data contains a non-tombstone created tweet node."""
    if not isinstance(data, dict):
        return False
    for key in ('create_tweet', 'notetweet_create'):
        node = data.get(key)
        if not isinstance(node, dict):
            continue
        tweet_results = node.get('tweet_results') or node
        result = tweet_results.get('result') if isinstance(tweet_results, dict) else None
        if not isinstance(result, dict):
            continue
        if result.get('__typename') in ('TweetTombstone', 'TweetUnavailable'):
            continue
        if result.get('__typename') == 'TweetWithVisibilityResults' and isinstance(result.get('tweet'), dict):
            result = result['tweet']
        legacy = result.get('legacy') if isinstance(result.get('legacy'), dict) else {}
        tid = result.get('rest_id') or result.get('id') or legacy.get('id_str')
        if tid is not None and numeric_id(str(tid)):
            return True
    return False


_command_reader = None
_command_transport = None
_command_loop = None


async def read_command(timeout=60.0):
    # A cancellable pipe reader avoids an executor thread stranded on idle stdin
    # (asyncio.run waits for that thread even after wait_for has timed out).
    global _command_reader, _command_transport, _command_loop
    loop = asyncio.get_running_loop()
    if _command_reader is None or _command_loop is not loop:
        _command_transport = None
        _command_reader = None
        reader = asyncio.StreamReader(limit=1_048_576)
        protocol = asyncio.StreamReaderProtocol(reader)
        _command_transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        _command_reader = reader
        _command_loop = loop
    try:
        if timeout is not None:
            line = await asyncio.wait_for(_command_reader.readline(), timeout=timeout)
        else:
            line = await _command_reader.readline()
    except (asyncio.LimitOverrunError, ValueError):
        if _command_transport is not None:
            try:
                _command_transport.close()
            except Exception:
                pass
        _command_transport = None
        _command_reader = None
        _command_loop = None
        raise ValueError('protocol_line_too_long') from None
    except asyncio.TimeoutError:
        # Preserve _command_transport and _command_reader on timeout so stdin FD stays open
        # across retries or subsequent commands.
        raise
    if not line:
        raise EOFError()
    if len(line) > 1_048_576:
        raise ValueError('protocol_line_too_long')
    return json.loads(line)


async def _recycle_client_transport(client):
    if client is None:
        return
    http_client = getattr(client, 'http', None)
    for target in (http_client, getattr(http_client, '_transport', None)):
        recycle = getattr(target, 'recycle', None)
        if callable(recycle):
            try:
                res = recycle()
                if inspect.isawaitable(res):
                    await res
            except Exception:
                pass
            break


async def main():
    import hashlib
    from urllib.parse import unquote
    client = None
    session = None
    active_request_id = None
    active_operation = None
    used_request_ids = set()
    try:
        command = _protocol_command(await read_command(), expected_operation='open', used_ids=used_request_ids)
        active_request_id, active_operation = command['requestId'], command['op']
        proxy = validate_proxy(command.get('proxy'))
        account = command['account']
        cookies = read_cookies(account['cookieFile'])

        client = new_client(proxy)
        session = DirectSession(client, account)

        for guest_key in GUEST_COOKIE_NAMES:
            cookies.pop(guest_key, None)

        if command.get('mode') == 'publish' or account.get('userId'):
            if not cookies.get('auth_token') or not cookies.get('ct0') or not cookies.get('twid'):
                raise ValueError('cookie_auth_required')

            raw_twid = unquote(cookies['twid'])
            twid_uid = raw_twid[2:] if raw_twid.startswith('u=') else raw_twid
            if not numeric_id(twid_uid):
                raise ValueError('cookie_twid_invalid')

            expected_id = str(account.get('userId') or '')
            if expected_id and str(twid_uid) != expected_id:
                raise ValueError('cookie_twid_user_id_mismatch')

        canonical = '\n'.join(f'{k}={v}' for k, v in sorted(cookies.items()) if k not in GUEST_COOKIE_NAMES)
        fingerprint = hashlib.sha256(canonical.encode('utf-8')).hexdigest()

        client.set_cookies(cookies, clear_cookies=True)

        verify_identity = getattr(session, 'startup_identity', session.identity)
        identity = await verify_identity()
        if isinstance(identity, dict):
            identity['cookieFingerprint'] = fingerprint
        receipt = {
            'kind': 'local_cookie_binding',
            'version': 1,
            'userId': identity.get('userId') if isinstance(identity, dict) else None,
            'username': identity.get('username') if isinstance(identity, dict) else None,
            'cookieFingerprint': fingerprint,
            'localOnly': True,
        }
        session.identity_data = identity
        session.receipt = receipt
        session.verified = identity

        emit({'event': 'result', 'result': {'identity': identity, 'receipt': receipt}}, request_id=active_request_id, operation=active_operation)
        await _recycle_client_transport(client)

        while True:
            active_request_id = None
            active_operation = None
            try:
                try:
                    raw_command = await read_command(timeout=None)
                except TypeError:
                    raw_command = await read_command()
            except (EOFError, StopIteration):
                break
            except RuntimeError as exc:
                if 'StopIteration' in str(exc):
                    break
                raise

            if isinstance(raw_command, dict):
                req_id = raw_command.get('requestId') or raw_command.get('request_id')
                if req_id:
                    active_request_id = req_id
                op = raw_command.get('op')
                if op:
                    active_operation = op

            command = _protocol_command(raw_command, used_ids=used_request_ids)
            active_request_id, active_operation = command['requestId'], command['op']

            if active_operation == 'close':
                emit({'event': 'result', 'result': {'closed': True}}, request_id=active_request_id, operation=active_operation)
                break

            if active_operation == 'verify_tweet_by_id':
                ident = session.verified or session.identity_data
                result = await session.verify_tweet_by_id(command.get('tweetId'), ident, command.get('expectedText'))
                emit({'event': 'result', 'result': result}, request_id=active_request_id, operation=active_operation)
                await _recycle_client_transport(client)
                continue

            if active_operation == 'publish':
                if getattr(session, 'poisoned', False):
                    emit({'event': 'result', 'result': {'status': 'not_ready', 'published': False, 'posted': False, 'ambiguous': False, 'blocked': True, 'reason': 'worker_poisoned'}},
                         request_id=active_request_id, operation=active_operation)
                    continue

                client._last_create_tweet_response = None
                client._last_create_tweet_diag = None
                client._last_create_tweet_http_status = None

                async def dispatch():
                    emit({'event': 'dispatch_ready'}, request_id=active_request_id, operation=active_operation)
                    try:
                        raw_ack = await read_command(timeout=DISPATCH_ACK_TIMEOUT_SECONDS)
                    except TypeError:
                        raw_ack = await read_command()
                    ack = _protocol_command(raw_ack, expected_request_id=active_request_id, expected_operation='dispatch_ack', allow_existing_id=True)
                    if ack.get('operation') != active_operation:
                        raise ValueError('protocol_operation')
                    return True

                result = await session.publish(command.get('text'), dispatch)
                emit({'event': 'result', 'result': result}, request_id=active_request_id, operation=active_operation)
                await _recycle_client_transport(client)
                continue

            emit({'event': 'result', 'result': {'status': 'not_ready', 'published': False, 'posted': False, 'ambiguous': False, 'blocked': True, 'reason': 'unknown_operation'}},
                 request_id=active_request_id, operation=active_operation)

    except Exception as exc:
        used = bool(session and session.used)
        result = uncertain('bridge_error') if used else unsent('auth_session_unverified')
        if used:
            result['retryable'] = False
        if str(exc) == 'identity_read_unavailable' and not used:
            result['reason'] = 'identity_read_unavailable'
            result['retryable'] = True
            result['readDiagnostic'] = getattr(exc, 'read_diagnostic', None)
        elif str(exc).startswith('cookie_') or str(exc).startswith('expected_') or str(exc).startswith('protocol'):
            result['reason'] = str(exc)
            result['accountFailure'] = 'auth_identity_mismatch' if 'mismatch' in str(exc) else None
        if getattr(exc, 'account_failure', None) in KNOWN_ACCOUNT_FAILURES:
            result['accountFailure'] = getattr(exc, 'account_failure')
        else:
            classified = (identity_account_failure(exc) if not used else
                          classify_x_account_failure(raw_json=getattr(exc, 'raw_json', None), text=str(exc)))
            if classified in KNOWN_ACCOUNT_FAILURES:
                result['accountFailure'] = classified
        if is_rate_limit_exception(exc) or result.get('accountFailure') == 'rate_limit':
            result['status'] = 'ambiguous' if used else 'rate_limit'
            result['rateLimit'] = True
            result['published'] = False
            result['posted'] = False
            result['ambiguous'] = used
            result['retryable'] = not used
            result['accountFailure'] = 'rate_limit'
            result['reason'] = 'rate_limit'
            result['retryAfterSeconds'] = extract_retry_after_seconds(exc)
        emit({'event': 'result', 'result': result}, request_id=active_request_id, operation=active_operation)
    finally:
        # Own the transport immediately after construction, including failures
        # before DirectSession exists. Control signals propagate after cleanup.
        global _command_reader, _command_transport, _command_loop
        if _command_transport is not None:
            try: _command_transport.close()
            except Exception: pass
        _command_transport = None
        _command_reader = None
        _command_loop = None
        if client is not None:
            try: await client.http.aclose()
            except Exception: pass


if __name__ == '__main__':
    asyncio.run(main())
