import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import redis
import redis.asyncio as async_redis

import demo_app
from server import CacheServer
from test_core import request


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.server = CacheServer(timeout=2)
        self.port = await self.server.start(port=0)
        self.client = async_redis.Redis(
            host="127.0.0.1", port=self.port, protocol=2,
            decode_responses=True, socket_timeout=2, socket_connect_timeout=2,
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        await self.server.close()

    async def connect(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        return await asyncio.open_connection("127.0.0.1", self.port)

    async def test_real_redis_client(self) -> None:
        self.assertTrue(await self.client.ping())
        await self.client.execute_command("CLIENT", "SETINFO", "LIB-NAME", "integration")
        await self.client.execute_command("SELECT", 0)
        with self.assertRaises(redis.ResponseError):
            await self.client.execute_command("SELECT", 1)
        self.assertTrue(await self.client.set("product:101", json.dumps({"id": 101}), ex=300))
        self.assertEqual(json.loads(await self.client.get("product:101")), {"id": 101})
        self.assertTrue(295 <= await self.client.ttl("product:101") <= 300)
        self.assertIsNone(await self.client.set("product:101", "no", nx=True))
        self.assertTrue(await self.client.set("product:101", "yes", xx=True))
        self.assertEqual(await self.client.ttl("product:101"), -1)
        self.assertEqual(await self.client.exists("product:101", "missing"), 1)
        self.assertEqual(await self.client.delete("product:101"), 1)

    async def test_wire_expiration(self) -> None:
        await self.client.set("short", "value", px=30)
        for _ in range(100):
            if await self.client.get("short") is None:
                break
            await asyncio.sleep(0.01)
        self.assertIsNone(await self.client.get("short"))
        self.assertEqual(await self.client.pttl("short"), -2)

    async def test_concurrent_clients_and_pipeline(self) -> None:
        async def worker(index: int) -> None:
            await self.client.set(f"k:{index}", str(index))
            self.assertEqual(await self.client.get(f"k:{index}"), str(index))
        await asyncio.gather(*(worker(i) for i in range(20)))
        # redis-py pipelines default to MULTI/EXEC, which are outside this subset.
        async with self.client.pipeline(transaction=False) as pipeline:
            pipeline.set("pipe", "value")
            pipeline.get("pipe")
            self.assertEqual(await pipeline.execute(), [True, "value"])
        self.assertEqual(await self.client.dbsize(), 21)
        self.assertTrue(await self.client.flushdb())
        self.assertEqual(await self.client.dbsize(), 0)

    async def test_framing_error_isolated_and_connection_closed(self) -> None:
        reader, writer = await self.connect()
        try:
            writer.write(b"*1\r\n$1\r\nxXX")
            await writer.drain()
            self.assertTrue((await asyncio.wait_for(reader.readline(), 2)).startswith(b"-ERR "))
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
            self.assertTrue(await self.client.ping())
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_command_error_keeps_connection_usable(self) -> None:
        reader, writer = await self.connect()
        try:
            writer.write(request(b"NOPE") + request(b"PING"))
            await writer.drain()
            self.assertTrue((await reader.readline()).startswith(b"-ERR "))
            self.assertEqual(await reader.readline(), b"+PONG\r\n")
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_client_limit_and_read_timeout(self) -> None:
        limited = CacheServer(max_clients=1, timeout=0.1)
        port = await limited.start(port=0)
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        other_reader, other_writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            self.assertIn(b"maximum clients", await asyncio.wait_for(other_reader.readline(), 2))
            self.assertIn(b"timed out", await asyncio.wait_for(reader.readline(), 2))
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
        finally:
            writer.close()
            other_writer.close()
            await writer.wait_closed()
            await other_writer.wait_closed()
            await limited.close()

    async def test_janitor_and_shutdown(self) -> None:
        self.server.store.set(b"expire", b"value", ttl_ms=1)
        for _ in range(40):
            if b"expire" not in self.server.store.data:
                break
            await asyncio.sleep(0.05)
        self.assertNotIn(b"expire", self.server.store.data)
        reader, writer = await self.connect()
        try:
            await self.server.close()
            self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
            self.assertFalse(self.server.tasks)
            self.assertFalse(self.server.connections)
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_demo_database_called_once_per_key(self) -> None:
        def exercise() -> None:
            client = redis.Redis(host="127.0.0.1", port=self.port, protocol=2,
                                 decode_responses=True, socket_timeout=2)
            try:
                with patch.object(demo_app, "cache", client), patch.object(
                    demo_app, "get_product_from_database",
                    wraps=demo_app.get_product_from_database,
                ) as database:
                    first = demo_app.get_product(101)
                    second = demo_app.get_product(101)
                    third = demo_app.get_product(102)
                    self.assertEqual(first, second)
                    self.assertEqual(third["id"], 102)
                    self.assertEqual(database.call_count, 2)
                    self.assertTrue(295 <= client.ttl("product:101") <= 300)
            finally:
                client.close()
        await asyncio.to_thread(exercise)

    async def test_original_demo_subprocess(self) -> None:
        env = dict(os.environ, REDIS_HOST="127.0.0.1", REDIS_PORT=str(self.port))
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(demo_app.__file__).resolve()),
            env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 10)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        self.assertEqual(process.returncode, 0, stderr.decode())
        self.assertEqual(stdout.count(b"Cache miss"), 2)
        self.assertEqual(stdout.count(b"Cache hit"), 2)
        self.assertIn(b"Laptop", stdout)
