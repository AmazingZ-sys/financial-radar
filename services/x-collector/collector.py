"""Internal, single authorized-session X collector. No paid data endpoints."""
from __future__ import annotations

import asyncio
from contextlib import aclosing
from contextvars import ContextVar
from datetime import datetime, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from urllib.parse import urlsplit

MAX_BODY_BYTES = 32_768
MAX_RESPONSE_BYTES = 2_000_000
TWITTER_EPOCH_MS = 1_288_834_974_657
ID_RE = re.compile(r"[0-9]{1,19}\Z")
COOKIE_RE = re.compile(r"[A-Za-z0-9._~%+/=-]{1,2048}\Z")
SEARCH_OBSERVATION: ContextVar[dict | None] = ContextVar("search_observation", default=None)


class CollectionError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: int = 0):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.retry_after = retry_after


def invalid_request() -> CollectionError:
    return CollectionError(400, "INVALID_REQUEST", "采集请求字段或固定查询窗口无效")


def parse_cookies(value: object) -> str:
    if not isinstance(value, str) or len(value.strip()) > 4096 or "\r" in value or "\n" in value:
        raise invalid_request()
    cookies: dict[str, str] = {}
    parts = [part.strip() for part in value.strip().split(";")]
    if parts[-1] == "":
        parts.pop()
    for part in parts:
        name, separator, secret = part.partition("=")
        name, secret = name.strip(), secret.strip()
        if not separator or name not in {"auth_token", "ct0"} or name in cookies or not COOKIE_RE.fullmatch(secret):
            raise invalid_request()
        cookies[name] = secret
    if set(cookies) != {"auth_token", "ct0"}:
        raise invalid_request()
    return f"auth_token={cookies['auth_token']}; ct0={cookies['ct0']}"


def timestamp(value: object) -> datetime:
    if not isinstance(value, str) or len(value) > 40:
        raise invalid_request()
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise invalid_request() from None


def validate_request(body: object) -> dict:
    fields = {"query", "sessionCookies", "maxResults", "sinceId", "startTime", "endTime", "beforeId"}
    if not isinstance(body, dict) or set(body) - fields:
        raise invalid_request()
    query = body.get("query")
    maximum = body.get("maxResults")
    if (
        not isinstance(query, str) or not 1 <= len(query) <= 512
        or any(ord(char) < 32 for char in query)
        or type(maximum) is not int or not 10 <= maximum <= 100
        or bool(body.get("sinceId")) == bool(body.get("startTime"))
    ):
        raise invalid_request()
    result = {**body, "sessionCookies": parse_cookies(body.get("sessionCookies"))}
    for key in ("sinceId", "beforeId"):
        if key in result and (not isinstance(result[key], str) or not ID_RE.fullmatch(result[key])):
            raise invalid_request()
    end = timestamp(body.get("endTime"))
    if "startTime" in body and timestamp(body["startTime"]) >= end:
        raise invalid_request()
    return result


def boundary_id(value: str) -> int:
    # Search ID operators fix the sub-day window without relying on date-only operators.
    millis = math.ceil(timestamp(value).timestamp() * 1000)
    if millis <= TWITTER_EPOCH_MS:
        raise invalid_request()
    return (millis - TWITTER_EPOCH_MS) << 22


def bounded_query(request: dict) -> str:
    lower = int(request["sinceId"]) if "sinceId" in request else boundary_id(request["startTime"]) - 1
    upper = boundary_id(request["endTime"]) - 1
    if "beforeId" in request:
        upper = min(upper, int(request["beforeId"]) - 1)
    if lower >= upper:
        raise invalid_request()
    return f"{request['query']} since_id:{lower} max_id:{upper}"


def valid_id(value: object) -> str:
    value = str(value) if value is not None else ""
    if not ID_RE.fullmatch(value):
        raise CollectionError(502, "INVALID_SOURCE", "X 返回的原帖身份字段不完整，未推进游标")
    return value


def map_post(post: object) -> dict:
    post_id = valid_id(getattr(post, "id_str", None))
    author = getattr(post, "user", None)
    author_id = valid_id(getattr(author, "id_str", None))
    date = getattr(post, "date", None)
    text = getattr(post, "rawContent", None)
    if not isinstance(date, datetime) or date.tzinfo is None or not isinstance(text, str) or not 1 <= len(text) <= 50_000:
        raise CollectionError(502, "INVALID_SOURCE", "X 返回的作者、正文或发布时间不完整，未推进游标")
    references = []
    for field, kind in (("retweetedTweet", "retweeted"), ("quotedTweet", "quoted")):
        reference = getattr(post, field, None)
        if reference is not None:
            references.append({"id": valid_id(getattr(reference, "id_str", None)), "type": kind})
    reply = getattr(post, "inReplyToTweetIdStr", None)
    if reply:
        references.append({"id": valid_id(reply), "type": "replied_to"})
    tags = {}
    for field in ("hashtags", "cashtags"):
        values = getattr(post, field, [])
        if not isinstance(values, list) or len(values) > 100 or any(not isinstance(v, str) or not 1 <= len(v) <= 200 for v in values):
            raise CollectionError(502, "INVALID_SOURCE", "X 返回的话题字段无效，未推进游标")
        tags[field] = list(dict.fromkeys(values))
    return {
        "id": post_id, "authorId": author_id, "text": text,
        "createdAt": date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "originalUrl": f"https://x.com/i/web/status/{post_id}",
        "referencedPosts": references, **tags,
    }


def entry_post_ids(instructions: list) -> set[str]:
    """Read timeline items only, never recursively promote quoted originals."""
    identities: set[str] = set()
    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
        elif isinstance(node, dict):
            if "tweet_results" in node:
                result = node["tweet_results"].get("result", {})
                if result.get("__typename") == "TweetWithVisibilityResults":
                    result = result.get("tweet", {})
                identity = result.get("rest_id") or result.get("legacy", {}).get("id_str")
                if identity is not None:
                    identities.add(valid_id(identity))
                return
            for key in ("entries", "entry", "content", "itemContent", "items", "item", "moduleItems"):
                if key in node:
                    visit(node[key])
    visit(instructions)
    return identities


def raise_observed_status(observation: dict):
    if observation.get("authFailed"):
        raise CollectionError(401, "SESSION_EXPIRED", "X 登录态已失效或账号受限，请在管理页更新")
    if observation.get("rateRetry", 0) > 0:
        raise CollectionError(429, "X_RATE_LIMIT", "X 已限流，采集已暂停", observation["rateRetry"])
    if observation.get("sourceErrors"):
        raise CollectionError(502, "PARTIAL_SOURCE", "X 搜索返回部分错误，未推进采集游标")


def prepare_twscrape():
    # Pinning is deliberate: these transport hooks are checked by contract tests.
    os.environ["TWS_TELEMETRY"] = "0"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ.pop("TWS_PROXY", None)
    import httpx
    from twscrape import API
    import twscrape.account as account_module
    import twscrape.xclid as xclid_module
    import twscrape.queue_client as queue_module
    import twscrape.models as models_module
    from twscrape.http import HttpxClient
    from twscrape.logger import logger

    logger.remove()  # Never emit upstream bodies, session material or account diagnostics.

    def reject_parse_dump(kind, error, item, response):
        # The upstream default writes full responses to /tmp and skips bad posts.
        # Preserve completeness and keep raw source material out of diagnostics.
        raise CollectionError(502, "SOURCE_PARSE_FAILED", "X 帖子解析失败，未推进采集游标") from None

    models_module._write_dump = reject_parse_dump

    class DirectClient(HttpxClient):
        def __init__(self, *, proxy=None, headers=None, cookies=None, seed=None):
            self._httpx = httpx
            safe_headers = dict(headers or {})
            if safe_headers.get("user-agent", "").startswith("@"):
                safe_headers["user-agent"] = "Mozilla/5.0"
            self._client = httpx.AsyncClient(
                headers=safe_headers, cookies=cookies or {}, timeout=10,
                follow_redirects=False, trust_env=False,
                transport=httpx.AsyncHTTPTransport(retries=0),
            )

        async def request(self, method, url, **kwargs):
            parsed = urlsplit(url)
            if (
                parsed.scheme != "https" or parsed.hostname not in {"x.com", "www.x.com", "abs.twimg.com"}
                or parsed.path.startswith("/2/") or parsed.username or parsed.password
            ):
                raise CollectionError(502, "SOURCE_ENDPOINT", "X 采集出站地址不在公开网页白名单内")
            # No official /2/ endpoints, third-party data services or redirects.
            response = await super().request(method, url, **kwargs)
            observation = SEARCH_OBSERVATION.get()
            if observation is not None and parsed.hostname in {"x.com", "www.x.com"}:
                if response.status_code in {401, 403}:
                    observation["authFailed"] = True
                if response.status_code == 429:
                    try:
                        retry = float(response.headers.get("retry-after", "0"))
                        reset = float(response.headers.get("x-rate-limit-reset", "0")) - time.time()
                        seconds = max(retry, reset)
                        if not math.isfinite(seconds) or seconds <= 0:
                            seconds = 900
                    except (ValueError, OverflowError):
                        seconds = 900
                    observation["rateRetry"] = max(60, math.ceil(seconds))
            if observation is not None and parsed.path.startswith("/i/api/graphql/"):
                observation["responses"] += 1
                observation["lastStatus"] = response.status_code
                try:
                    body = response.json()
                    observation["sourceErrors"] = observation.get("sourceErrors", False) or bool(body.get("errors"))
                    instructions = body["data"]["search_by_raw_query"]["search_timeline"]["timeline"]["instructions"]
                    observation["valid"] += int(response.status_code == 200 and isinstance(instructions, list))
                    if response.status_code == 200 and isinstance(instructions, list):
                        observation["allowedIds"].update(entry_post_ids(instructions))
                except (KeyError, TypeError, ValueError):
                    pass
            if 300 <= response.status_code < 400:
                raise CollectionError(502, "SOURCE_REDIRECT", "X 返回跳转，采集已停止；请检查登录态")
            return response

    account_module._make_http_client = DirectClient
    xclid_module._make_http_client = DirectClient
    # twscrape treats some parser/transport aborts as None. Fail closed rather
    # than treating a partial or aborted search as a completed empty window.
    original_req = getattr(queue_module.QueueClient, "_radar_original_req", queue_module.QueueClient.req)
    queue_module.QueueClient._radar_original_req = original_req

    async def strict_req(self, method, url, params=None):
        result = await original_req(self, method, url, params=params)
        if result is None:
            raise CollectionError(502, "SOURCE_ABORTED", "X 搜索中断，未推进采集游标")
        return result

    queue_module.QueueClient.req = strict_req
    original_end = getattr(API, "_radar_original_end", API._is_end)
    API._radar_original_end = original_end

    def strict_end(self, response, queue, entries, cursor, count, limit):
        observation = SEARCH_OBSERVATION.get()
        if observation is not None:
            observation["limitReached"] = cursor is not None and limit > 0 and count + len(entries) >= limit
        return original_end(self, response, queue, entries, cursor, count, limit)

    def strict_stalled(self, queue, entries, cursor, seen):
        keys = [("cursor", cursor)] if cursor is not None else []
        identities = tuple(str(entry.get("entryId")) for entry in entries if isinstance(entry, dict) and entry.get("entryId") is not None)
        if identities:
            keys.append(("entries", *identities))
        if any(key in seen for key in keys):
            raise CollectionError(502, "SEARCH_STALLED", "X 返回重复搜索分页，未推进采集游标")
        seen.update(keys)
        return False

    API._is_end = strict_end
    API._is_stalled = strict_stalled
    return API


async def collect_with_twscrape(request: dict) -> dict:
    API = prepare_twscrape()
    from twscrape.accounts_pool import NoAccountError
    from twscrape.queue_client import XClIdGenStore
    observation = {"responses": 0, "valid": 0, "lastStatus": None, "limitReached": False, "allowedIds": set()}
    context_token = SEARCH_OBSERVATION.set(observation)
    with tempfile.TemporaryDirectory(prefix="radar-x-session-") as folder:
        api = API(str(Path(folder) / "session.sqlite"), debug=False, raise_when_no_account=True)
        await api.pool.add_account_cookies("authorized-session", request["sessionCookies"])
        posts: list[dict] = []
        try:
            async with aclosing(api.search(
                bounded_query(request), limit=request["maxResults"] + 1,
                kv={"count": min(100, request["maxResults"] + 1), "product": "Latest"},
            )) as stream:
                async for post in stream:
                    if str(getattr(post, "id_str", "")) not in observation["allowedIds"]:
                        continue
                    posts.append(map_post(post))
                    if len(posts) > request["maxResults"]:
                        break
            raise_observed_status(observation)
            # A parser/transport abort must not masquerade as an empty successful window.
            account = await api.pool.get("authorized-session")
            if account is None or not account.active:
                raise CollectionError(401, "SESSION_EXPIRED", "X 登录态已失效或账号受限，请在管理页更新")
            locks = list((account.locks or {}).values())
            lock_until = max((v.timestamp() for v in locks if isinstance(v, datetime)), default=0)
            if lock_until > time.time():
                raise CollectionError(429, "X_RATE_LIMIT", "X 已限流，采集已暂停", max(60, math.ceil(lock_until - time.time())))
            if observation["valid"] == 0:
                raise CollectionError(502, "INVALID_SOURCE", "X 未返回有效搜索窗口，不能据此判断无热点")
        except NoAccountError:
            raise_observed_status(observation)
            account = await api.pool.get("authorized-session")
            if account is None or not account.active:
                raise CollectionError(401, "SESSION_EXPIRED", "X 登录态已失效或账号受限，请在管理页更新") from None
            locks = list((account.locks or {}).values())
            until = max((v.timestamp() for v in locks if isinstance(v, datetime)), default=time.time() + 900)
            raise CollectionError(429, "X_RATE_LIMIT", "X 已限流，采集已暂停", max(60, math.ceil(until - time.time()))) from None
        except CollectionError:
            raise_observed_status(observation)
            raise
        finally:
            # The library cache contains a session-derived request signer; remove it too.
            XClIdGenStore.items.clear()
            SEARCH_OBSERVATION.reset(context_token)
        has_more = len(posts) > request["maxResults"] or observation["limitReached"]
        if has_more and not posts:
            raise CollectionError(502, "INCOMPLETE_SOURCE", "X 搜索仅返回分页标记，未推进采集游标")
        return {"posts": posts[:request["maxResults"]], "hasMore": has_more}


class Collector:
    def __init__(self, adapter=collect_with_twscrape, timeout_seconds: float = 15):
        self.adapter, self.timeout_seconds = adapter, timeout_seconds
        self.lock = threading.Lock()
        self.cooldown_until = 0.0

    def search(self, body: object) -> dict:
        request = validate_request(body)
        if not self.lock.acquire(blocking=False):
            raise CollectionError(429, "COLLECTOR_BUSY", "采集器正在处理请求，请稍后重试", 60)
        try:
            if self.cooldown_until > time.time():
                raise CollectionError(429, "X_RATE_LIMIT", "X 限流冷却中，未请求上游", math.ceil(self.cooldown_until - time.time()))
            async def run():
                async with asyncio.timeout(self.timeout_seconds):
                    return await self.adapter(request)
            return asyncio.run(run())
        except CollectionError as error:
            if error.status == 429:
                self.cooldown_until = time.time() + max(60, error.retry_after)
            raise
        except TimeoutError:
            raise CollectionError(504, "COLLECTOR_TIMEOUT", "X 采集超时，未自动重试或切换付费服务") from None
        except Exception:
            raise CollectionError(502, "SOURCE_UNAVAILABLE", "X 网页采集暂不可用，请检查登录态或采集器版本") from None
        finally:
            self.lock.release()


def handler_for(secret: str, collector: Collector):
    class Handler(BaseHTTPRequestHandler):
        server_version = "RadarCollector"
        sys_version = ""
        timeout = 20

        def log_message(self, format, *args):
            pass

        def send_json(self, status: int, body: dict, retry_after: int = 0):
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            if len(encoded) > MAX_RESPONSE_BYTES:
                status = 502
                encoded = b'{"error":{"code":"RESPONSE_TOO_LARGE","message":"X response exceeded size limit"}}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            if retry_after:
                self.send_header("Retry-After", str(retry_after))
            self.end_headers()
            self.wfile.write(encoded)
            self.close_connection = True

        def do_GET(self):
            if self.path == "/healthz":
                self.send_json(200, {"status": "ready", "dataMode": "live", "provider": "self-hosted"})
            else:
                self.send_json(404, {"error": {"code": "NOT_FOUND", "message": "Not found"}})

        def do_POST(self):
            try:
                authorization = self.headers.get("Authorization", "")
                if not hmac.compare_digest(authorization.encode(), f"Bearer {secret}".encode()):
                    raise CollectionError(403, "UNAUTHORIZED", "内部采集器共享密钥无效")
                if self.path != "/v1/search":
                    raise CollectionError(404, "NOT_FOUND", "Not found")
                if self.headers.get("Transfer-Encoding") or self.headers.get_content_type() != "application/json":
                    raise invalid_request()
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY_BYTES:
                    raise invalid_request()
                body = json.loads(self.rfile.read(length))
                self.send_json(200, collector.search(body))
            except CollectionError as error:
                self.send_json(error.status, {"error": {"code": error.code, "message": error.message}}, error.retry_after)
            except (ValueError, UnicodeError):
                self.send_json(400, {"error": {"code": "INVALID_REQUEST", "message": "Invalid JSON request"}})
            except Exception:
                self.send_json(502, {"error": {"code": "COLLECTOR_FAILURE", "message": "Collector unavailable"}})
    return Handler


class SafeServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # The stdlib default traceback could contain credential-bearing request state.
        pass


def main():
    secret = os.environ.get("X_COLLECTOR_SECRET", "")
    if len(secret) < 32:
        raise SystemExit("X_COLLECTOR_SECRET must contain at least 32 characters")
    os.umask(0o077)
    server = SafeServer(("0.0.0.0", 8080), handler_for(secret, Collector()))
    server.serve_forever()


if __name__ == "__main__":
    main()
