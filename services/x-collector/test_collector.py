import asyncio
from datetime import datetime, timezone
import importlib.util
import inspect
import json
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import collector

COOKIES = 'auth_token=synthetic-auth-only; ct0=synthetic-csrf-only'
SECRET = 'synthetic-internal-secret-at-least-32'
REQUEST = {
    'query': '(from:alice OR from:bob) -filter:retweets -filter:replies',
    'sessionCookies': COOKIES, 'maxResults': 10,
    'startTime': '2026-11-05T09:45:00.000Z', 'endTime': '2026-11-05T10:00:00.000Z',
}


def synthetic_post(index=0):
    return SimpleNamespace(
        id_str=str(1_800_000_000_000_000_020 - index), user=SimpleNamespace(id_str='123456'),
        rawContent='Synthetic contract test #Research $TEST',
        date=datetime(2026, 11, 5, 9, 55, tzinfo=timezone.utc),
        hashtags=['Research', 'Research'], cashtags=['TEST'],
        retweetedTweet=None, quotedTweet=None, inReplyToTweetIdStr=None,
    )


class RequestTests(unittest.TestCase):
    def test_canonical_cookie_contract(self):
        self.assertEqual(collector.parse_cookies(' ct0 = csrf=; auth_token = abc+/~._%-; '), 'auth_token=abc+/~._%-; ct0=csrf=')

    def test_reject_incomplete_extra_duplicate_or_multiline_cookies(self):
        for value in ['', 'auth_token=only', 'auth_token=a; ct0=b; other=c',
                      'auth_token=a; auth_token=b', 'auth_token=a; ct0=b\n',
                      'auth_token=; ct0=b', 'auth_token=' + 'a' * 2049 + '; ct0=b']:
            with self.subTest(value=value[:50]), self.assertRaises(collector.CollectionError):
                collector.parse_cookies(value)

    def test_validates_request_boundaries_and_fields(self):
        self.assertEqual(collector.validate_request(REQUEST), REQUEST)
        for extra in [ {'maxResults': True}, {'maxResults': 101}, {'beforeId': 'injection'},
                       {'query': 'bad\nquery'}, {'unknown': 'no'}, {'endTime': 'invalid'},
                       {'startTime': '2026-11-05T10:00:00Z'}, {'sinceId': '123'} ]:
            with self.subTest(extra=extra), self.assertRaises(collector.CollectionError):
                collector.validate_request({**REQUEST, **extra})

    def test_fixed_id_bounds_do_not_expand_pagination(self):
        lower = collector.boundary_id(REQUEST['startTime']) - 1
        upper = collector.boundary_id(REQUEST['endTime']) - 1
        self.assertTrue(collector.bounded_query(REQUEST).endswith(f'since_id:{lower} max_id:{upper}'))
        request = {**REQUEST, 'sinceId': '123', 'beforeId': '456'}
        request.pop('startTime')
        self.assertTrue(collector.bounded_query(request).endswith('since_id:123 max_id:455'))
        with self.assertRaises(collector.CollectionError):
            collector.bounded_query({**request, 'beforeId': '123'})

    def test_preserves_evidence_identity_and_actual_times(self):
        post = synthetic_post()
        post.quotedTweet = SimpleNamespace(id_str='123')
        result = collector.map_post(post)
        self.assertEqual(result['authorId'], '123456')
        self.assertEqual(result['createdAt'], '2026-11-05T09:55:00Z')
        self.assertEqual(result['hashtags'], ['Research'])
        self.assertEqual(result['referencedPosts'], [{'id': '123', 'type': 'quoted'}])
        self.assertEqual(result['originalUrl'], f'https://x.com/i/web/status/{post.id_str}')

    def test_never_invents_missing_author_or_publication_time(self):
        for key, value in [('user', None), ('date', None), ('rawContent', ''), ('id_str', 'not-id')]:
            post = synthetic_post()
            setattr(post, key, value)
            with self.subTest(key=key), self.assertRaises(collector.CollectionError):
                collector.map_post(post)

    def test_observed_upstream_auth_rate_and_partial_errors_never_become_empty_success(self):
        for observation, status in [({'authFailed': True}, 401), ({'rateRetry': 120}, 429), ({'sourceErrors': True}, 502)]:
            with self.subTest(observation=observation), self.assertRaises(collector.CollectionError) as raised:
                collector.raise_observed_status(observation)
            self.assertEqual(raised.exception.status, status)
        collector.raise_observed_status({})


class CollectorTests(unittest.TestCase):
    def test_stub_does_not_use_network_or_ai(self):
        calls = []
        async def adapter(request):
            calls.append(request)
            return {'posts': [collector.map_post(synthetic_post())], 'hasMore': False}
        result = collector.Collector(adapter).search(REQUEST)
        self.assertEqual(len(result['posts']), 1)
        self.assertEqual(len(calls), 1)

    def test_limits_whole_collection_time_without_retry(self):
        calls = []
        async def adapter(request):
            calls.append(request)
            await asyncio.sleep(1)
        with self.assertRaises(collector.CollectionError) as raised:
            collector.Collector(adapter, timeout_seconds=0.005).search(REQUEST)
        self.assertEqual(raised.exception.status, 504)
        self.assertEqual(len(calls), 1)

    def test_rate_limit_pauses_next_request_without_rotating_accounts(self):
        calls = []
        async def adapter(request):
            calls.append(request)
            raise collector.CollectionError(429, 'X_RATE_LIMIT', 'Rate limited', 120)
        service = collector.Collector(adapter)
        for _ in range(2):
            with self.assertRaises(collector.CollectionError) as raised:
                service.search(REQUEST)
            self.assertEqual(raised.exception.status, 429)
            self.assertGreaterEqual(raised.exception.retry_after, 119)
        self.assertEqual(len(calls), 1)

    def test_busy_collector_rejects_additional_session(self):
        service = collector.Collector()
        service.lock.acquire()
        try:
            with self.assertRaises(collector.CollectionError) as raised:
                service.search(REQUEST)
            self.assertEqual(raised.exception.code, 'COLLECTOR_BUSY')
        finally:
            service.lock.release()

    def test_exception_does_not_expose_session_material(self):
        async def adapter(request):
            raise RuntimeError(COOKIES)
        with self.assertRaises(collector.CollectionError) as raised:
            collector.Collector(adapter).search(REQUEST)
        self.assertNotIn('synthetic-auth', str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        async def adapter(request):
            self.calls.append(request)
            return {'posts': [], 'hasMore': False}
        self.server = collector.SafeServer(('127.0.0.1', 0), collector.handler_for(SECRET, collector.Collector(adapter)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, body, secret=SECRET):
        request = Request(self.base + '/v1/search', data=json.dumps(body).encode(),
                          headers={'Authorization': f'Bearer {secret}', 'Content-Type': 'application/json'})
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers

    def test_shared_secret_is_required_before_collection(self):
        status, body, _ = self.post(REQUEST, 'wrong-secret')
        self.assertEqual(status, 403)
        self.assertNotIn('synthetic', json.dumps(body))
        self.assertEqual(self.calls, [])

    def test_reads_internal_contract_and_never_echoes_cookies(self):
        status, body, headers = self.post(REQUEST)
        self.assertEqual(status, 200)
        self.assertEqual(body, {'posts': [], 'hasMore': False})
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.calls, [REQUEST])
        self.assertNotIn('synthetic', json.dumps(body))

    def test_rejects_unbounded_input_and_unknown_fields(self):
        for body in [{**REQUEST, 'sessionCookies': COOKIES + '; other=secret'},
                     {**REQUEST, 'query': 'x' * 40_000}]:
            status, _, _ = self.post(body)
            self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_health_does_not_claim_x_connected_or_read_network(self):
        with urlopen(self.base + '/healthz', timeout=2) as response:
            self.assertEqual(json.load(response), {'status': 'ready', 'dataMode': 'live', 'provider': 'self-hosted'})
        self.assertEqual(self.calls, [])


@unittest.skipUnless(importlib.util.find_spec('twscrape'), 'install pinned requirements for transport contract tests')
class TwscrapeContractTests(unittest.TestCase):
    def test_installed_signature_and_session_import_without_network(self):
        from importlib.metadata import version
        API = collector.prepare_twscrape()
        self.assertEqual(version('twscrape'), '0.20.1')
        self.assertIn('raise_when_no_account', inspect.signature(API).parameters)
        self.assertIn('kv', inspect.signature(API.search).parameters)
        from twscrape.accounts_pool import AccountsPool
        self.assertIn('cookies', inspect.signature(AccountsPool.add_account_cookies).parameters)
        self.assertEqual(__import__('os').environ['TWS_TELEMETRY'], '0')

    def test_single_ephemeral_account_and_bounded_extra_result(self):
        RealAPI = collector.prepare_twscrape()
        database_paths, observed_queries = [], []
        class API(RealAPI):
            def __init__(self, database, **kwargs):
                database_paths.append(database)
                super().__init__(database, **kwargs)
            async def search(self, query, limit=-1, kv=None):
                observed_queries.append((query, limit, kv))
                collector.SEARCH_OBSERVATION.get()['valid'] = 1
                collector.SEARCH_OBSERVATION.get()['allowedIds'].update(synthetic_post(index).id_str for index in range(11))
                self_accounts = await self.pool.accounts_info()
                if len(self_accounts) != 1:
                    raise AssertionError('Only one authorized session is permitted')
                for index in range(11):
                    yield synthetic_post(index)
        with patch.object(collector, 'prepare_twscrape', return_value=API):
            result = asyncio.run(collector.collect_with_twscrape(REQUEST))
        self.assertTrue(result['hasMore'])
        self.assertEqual(len(result['posts']), 10)
        self.assertEqual(observed_queries[0][1], 11)
        self.assertIn('max_id:', observed_queries[0][0])
        self.assertTrue(all(not Path(path).exists() for path in database_paths))

    def test_no_account_lock_maps_to_pause_without_waiting_or_session_rotation(self):
        RealAPI = collector.prepare_twscrape()
        from twscrape.accounts_pool import NoAccountError
        class API(RealAPI):
            async def search(self, query, limit=-1, kv=None):
                await self.pool.lock_until('authorized-session', 'SearchTimeline', int(time.time()) + 120)
                raise NoAccountError('synthetic detail must remain private')
                yield
        with patch.object(collector, 'prepare_twscrape', return_value=API):
            with self.assertRaises(collector.CollectionError) as raised:
                asyncio.run(collector.collect_with_twscrape(REQUEST))
        self.assertEqual(raised.exception.status, 429)
        self.assertGreaterEqual(raised.exception.retry_after, 118)
        self.assertNotIn('synthetic', str(raised.exception))

    def test_inactive_session_maps_to_update_required(self):
        RealAPI = collector.prepare_twscrape()
        from twscrape.accounts_pool import NoAccountError
        class API(RealAPI):
            async def search(self, query, limit=-1, kv=None):
                await self.pool.mark_inactive('authorized-session', 'synthetic-private-upstream-error')
                raise NoAccountError('no account')
                yield
        with patch.object(collector, 'prepare_twscrape', return_value=API):
            with self.assertRaises(collector.CollectionError) as raised:
                asyncio.run(collector.collect_with_twscrape(REQUEST))
        self.assertEqual(raised.exception.status, 401)
        self.assertNotIn('synthetic', str(raised.exception))

    def test_aborted_scrape_cannot_be_reported_as_no_hotspots(self):
        RealAPI = collector.prepare_twscrape()
        class API(RealAPI):
            async def search(self, query, limit=-1, kv=None):
                return
                yield
        with patch.object(collector, 'prepare_twscrape', return_value=API):
            with self.assertRaises(collector.CollectionError) as raised:
                asyncio.run(collector.collect_with_twscrape(REQUEST))
        self.assertEqual(raised.exception.code, 'INVALID_SOURCE')

    def test_transport_blocks_paid_hosts_paid_paths_and_redirects_without_network(self):
        collector.prepare_twscrape()
        import httpx
        import twscrape.account as account_module
        async def verify():
            client = account_module._make_http_client(headers={}, cookies={})
            requests = []
            async def handle(request):
                requests.append(str(request.url))
                return httpx.Response(302, headers={'Location': 'https://api.x.com/2/tweets/search/recent'})
            await client._client.aclose()
            client._client = httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=False, trust_env=False)
            try:
                for url in ['https://api.x.com/2/tweets/search/recent', 'https://x.com/2/tweets/search/recent', 'https://example.com/data']:
                    with self.assertRaises(collector.CollectionError):
                        await client.get(url)
                self.assertEqual(requests, [])
                with self.assertRaises(collector.CollectionError) as raised:
                    await client.get('https://x.com/i/api/graphql/test/SearchTimeline')
                self.assertEqual(raised.exception.code, 'SOURCE_REDIRECT')
                self.assertEqual(len(requests), 1)
            finally:
                await client.aclose()
        asyncio.run(verify())

    def test_actual_queue_client_abort_cannot_end_as_successful_empty_results(self):
        collector.prepare_twscrape()
        from twscrape.queue_client import QueueClient
        class EmptyPool:
            async def get_for_queue_or_wait(self, queue):
                return None
        async def verify():
            client = QueueClient(EmptyPool(), 'SearchTimeline')
            with self.assertRaises(collector.CollectionError) as raised:
                await client.req('GET', 'https://x.com/i/api/graphql/test/SearchTimeline')
            self.assertEqual(raised.exception.code, 'SOURCE_ABORTED')
        asyncio.run(verify())

    def test_partial_response_keeps_pagination_and_rejects_internal_cursor_cycles(self):
        API = collector.prepare_twscrape()
        api = API()
        seen = set()
        self.assertFalse(api._is_stalled('SearchTimeline', [{'entryId': 'tweet-1'}], 'page-a', seen))
        self.assertFalse(api._is_stalled('SearchTimeline', [{'entryId': 'tweet-2'}], 'page-b', seen))
        with self.assertRaises(collector.CollectionError):
            api._is_stalled('SearchTimeline', [{'entryId': 'tweet-3'}], 'page-a', seen)
        observation = {'limitReached': False}
        token = collector.SEARCH_OBSERVATION.set(observation)
        try:
            api._is_end(object(), 'SearchTimeline', [1], 'still-more', 0, 1)
            self.assertTrue(observation['limitReached'])
            api._is_end(object(), 'SearchTimeline', [], 'empty-tail', 0, 1)
            self.assertFalse(observation['limitReached'])
        finally:
            collector.SEARCH_OBSERVATION.reset(token)

    def test_failed_post_parser_does_not_skip_evidence_or_write_response_dumps(self):
        collector.prepare_twscrape()
        import twscrape.models as models
        def failing_parser(item, response):
            raise ValueError('synthetic-private-response')
        with patch.object(models, 'to_old_rep', return_value={'tweets': {'123': {'id_str': '123'}}}), patch('builtins.open') as write:
            with self.assertRaises(collector.CollectionError) as raised:
                list(models._parse_items({}, 'tweet', failing_parser))
            self.assertEqual(raised.exception.code, 'SOURCE_PARSE_FAILED')
            self.assertNotIn('synthetic', str(raised.exception))
            write.assert_not_called()

    def test_nested_quoted_originals_are_not_promoted_to_unwatched_author_evidence(self):
        parent = synthetic_post()
        child = synthetic_post(1)
        child.user = SimpleNamespace(id_str='999999')
        parent.quotedTweet = child
        instructions = [{'type': 'TimelineAddEntries', 'entries': [{
            'content': {'itemContent': {'tweet_results': {'result': {
                '__typename': 'TweetWithVisibilityResults', 'tweet': {
                    'rest_id': parent.id_str,
                    'quoted_status_result': {'result': {'rest_id': child.id_str}},
                },
            }}}},
        }]}]
        allowed = collector.entry_post_ids(instructions)
        self.assertEqual(allowed, {parent.id_str})
        RealAPI = collector.prepare_twscrape()
        class API(RealAPI):
            async def search(self, query, limit=-1, kv=None):
                observation = collector.SEARCH_OBSERVATION.get()
                observation['valid'] = 1
                observation['allowedIds'].update(allowed)
                yield child
                yield parent
        with patch.object(collector, 'prepare_twscrape', return_value=API):
            result = asyncio.run(collector.collect_with_twscrape(REQUEST))
        self.assertEqual([post['id'] for post in result['posts']], [parent.id_str])
        self.assertEqual(result['posts'][0]['referencedPosts'], [{'id': child.id_str, 'type': 'quoted'}])


if __name__ == '__main__':
    unittest.main()
