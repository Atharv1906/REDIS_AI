import asyncio
import unittest

from resp import MAX_BULK, ProtocolError, bulk, read_request
from server import dispatch
from store import ENTRY_OVERHEAD, MAX_KEY, Store


def request(*args: bytes) -> bytes:
    return b"*" + str(len(args)).encode() + b"\r\n" + b"".join(bulk(arg) for arg in args)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def parse(self, wire: bytes) -> list[bytes]:
        reader = asyncio.StreamReader(limit=128)
        reader.feed_data(wire)
        reader.feed_eof()
        return await read_request(reader)

    async def test_binary_and_pipeline(self) -> None:
        reader = asyncio.StreamReader(limit=128)
        reader.feed_data(request(b"ECHO", b"\x00\xff\r\n") + request(b"PING"))
        self.assertEqual(await read_request(reader), [b"ECHO", b"\x00\xff\r\n"])
        self.assertEqual(await read_request(reader), [b"PING"])

    async def test_fragmentation(self) -> None:
        reader = asyncio.StreamReader(limit=128)
        task = asyncio.create_task(read_request(reader))
        for byte in request(b"SET", b"key", b"value"):
            reader.feed_data(bytes([byte]))
            await asyncio.sleep(0)
        self.assertEqual(await task, [b"SET", b"key", b"value"])

    async def test_rejects_bad_frames_and_limits(self) -> None:
        frames = [
            b"*0\r\n",
            b"*129\r\n",
            b"PING\r\n",
            b"*-1\r\n",
            b"*1\r\n$-1\r\n",
            b"*1\r\n$x\r\n",
            b"*1\r\n$1\r\naXX",
            b"*1\r\n$1048577\r\n",
            b"*" + b"1" * 129 + b"\r\n",
            b"*1\r\n+" + b"a" * 129 + b"\r\n",
        ]
        for frame in frames:
            with self.subTest(frame=frame[:40]):
                with self.assertRaises(ProtocolError):
                    await self.parse(frame)

    async def test_request_budget(self) -> None:
        wire = request(b"x" * MAX_BULK, b"x" * MAX_BULK)
        wire = wire.replace(b"*2\r\n", b"*3\r\n", 1) + b"$4096\r\n"
        with self.assertRaisesRegex(ProtocolError, "request exceeds limit"):
            await self.parse(wire)

    async def test_truncated_frame(self) -> None:
        for wire in (b"*1\r\n$5\r\nabc", b"*1\r\n$5"):
            with self.assertRaises(asyncio.IncompleteReadError):
                await self.parse(wire)


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 100.0
        self.store = Store(clock=lambda: self.now)

    def test_expiration_persist_and_replacement(self) -> None:
        self.assertEqual(self.store.ttl(b"k"), -2)
        self.store.set(b"k", b"v", 2000)
        self.assertEqual(self.store.ttl(b"k"), 2)
        self.assertEqual(self.store.ttl(b"k", True), 2000)
        self.now += 1
        self.assertEqual(self.store.persist(b"k"), 1)
        self.now += 5
        self.assertEqual(self.store.get(b"k"), b"v")
        self.assertEqual(self.store.ttl(b"k"), -1)
        self.assertEqual(self.store.persist(b"k"), 0)
        self.assertEqual(self.store.expire(b"k", 100), 1)
        self.store.set(b"k", b"new")
        self.assertEqual(self.store.ttl(b"k"), -1)
        self.store.expire(b"k", 100)
        self.now += 1
        self.assertIsNone(self.store.get(b"k"))
        self.assertEqual(self.store.used_bytes, 0)
        self.assertEqual(self.store.expire(b"missing", 1000), 0)
        self.store.set(b"k", b"v")
        self.assertEqual(self.store.expire(b"k", 0), 1)
        self.assertIsNone(self.store.get(b"k"))

    def test_lru_accounting_and_conditionals(self) -> None:
        unit = ENTRY_OVERHEAD + 2
        store = Store(unit * 2, clock=lambda: self.now)
        store.set(b"a", b"1")
        store.set(b"b", b"2")
        self.assertFalse(store.set(b"a", b"3", condition=b"NX"))
        self.assertFalse(store.set(b"c", b"3", condition=b"XX"))
        self.assertEqual(store.used_bytes, unit * 2)
        self.assertEqual(store.get(b"a"), b"1")
        store.set(b"c", b"3")
        self.assertIsNone(store.get(b"b"))
        self.assertEqual(store.get(b"a"), b"1")
        store.set(b"a", b"")
        self.assertEqual(store.used_bytes, unit * 2 - 1)
        self.assertEqual(store.delete(b"a"), 1)
        self.assertEqual(store.delete(b"a"), 0)
        store.clear()
        self.assertEqual(store.used_bytes, 0)
        self.assertFalse(store.deadlines)

    def test_oversized_write_preserves_old_value(self) -> None:
        store = Store(100)
        store.set(b"k", b"old")
        for key, value in ((b"k", b"x" * 100), (b"x" * (MAX_KEY + 1), b"v"),
                           (b"k", b"x" * (MAX_BULK + 1))):
            with self.assertRaises(ValueError):
                store.set(key, value)
        self.assertEqual(store.get(b"k"), b"old")

    def test_expired_entries_removed_before_live_eviction(self) -> None:
        store = Store((ENTRY_OVERHEAD + 2) * 2, clock=lambda: self.now)
        store.set(b"a", b"1")
        store.set(b"b", b"2", 100)
        self.now += 1
        store.set(b"c", b"3")
        self.assertEqual(store.get(b"a"), b"1")
        self.assertEqual(store.get(b"c"), b"3")
        self.assertIsNone(store.get(b"b"))

    def test_bounded_sweep_eventually_visits_every_deadline(self) -> None:
        for i in range(300):
            self.store.set(str(i).encode(), b"v", 1000)
        self.now += 2
        self.store.sweep(128)
        self.assertEqual(len(self.store.data), 172)
        self.store.sweep(128)
        self.store.sweep(128)
        self.assertEqual(self.store.used_bytes, 0)


class CommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = Store()

    def call(self, *args: bytes) -> bytes:
        return dispatch(self.store, list(args))

    def test_command_shapes(self) -> None:
        self.assertEqual(self.call(b"ping"), b"+PONG\r\n")
        self.assertEqual(self.call(b"PING", b"hello"), bulk(b"hello"))
        self.assertEqual(self.call(b"ECHO", b"\xff"), bulk(b"\xff"))
        self.assertEqual(self.call(b"GET", b"absent"), bulk(None))
        self.assertEqual(self.call(b"SET", b"k", b"v"), b"+OK\r\n")
        self.assertEqual(self.call(b"GET", b"k"), bulk(b"v"))
        self.assertEqual(self.call(b"EXISTS", b"k", b"k", b"absent"), b":2\r\n")
        self.assertEqual(self.call(b"DBSIZE"), b":1\r\n")
        self.assertEqual(self.call(b"DEL", b"k", b"k"), b":1\r\n")
        self.assertEqual(self.call(b"SELECT", b"0"), b"+OK\r\n")
        for field in (b"LIB-NAME", b"LIB-VER"):
            self.assertEqual(self.call(b"CLIENT", b"SETINFO", field, b"test"), b"+OK\r\n")
        self.assertEqual(self.call(b"FLUSHDB"), b"+OK\r\n")
        self.assertEqual(self.call(b"DBSIZE"), b":0\r\n")

    def test_options_and_expiry(self) -> None:
        self.assertEqual(self.call(b"SET", b"k", b"v", b"NX", b"EX", b"300"), b"+OK\r\n")
        self.assertEqual(self.call(b"SET", b"k", b"new", b"NX"), bulk(None))
        self.assertEqual(self.call(b"SET", b"absent", b"v", b"XX"), bulk(None))
        self.assertEqual(self.call(b"SET", b"k", b"new", b"PX", b"300000", b"XX"), b"+OK\r\n")
        self.assertTrue(self.call(b"TTL", b"k").startswith(b":"))
        self.assertEqual(self.call(b"PERSIST", b"k"), b":1\r\n")
        self.assertEqual(self.call(b"TTL", b"k"), b":-1\r\n")
        self.assertEqual(self.call(b"PEXPIRE", b"k", b"50000"), b":1\r\n")
        self.assertTrue(self.call(b"PTTL", b"k").startswith(b":"))
        self.assertEqual(self.call(b"EXPIRE", b"k", b"-1"), b":1\r\n")
        self.assertEqual(self.call(b"TTL", b"k"), b":-2\r\n")

    def test_invalid_commands_do_not_mutate(self) -> None:
        self.call(b"SET", b"k", b"old")
        options = [
            [b"EX"], [b"EX", b"0"], [b"PX", b"-1"], [b"NX", b"XX"],
            [b"NX", b"NX"], [b"EX", b"1", b"PX", b"1"], [b"EX", b"x"],
            [b"EX", b"9223372036854775807"], [b"GET"], [b"PX", b"1_000"],
        ]
        for option in options:
            with self.subTest(option=option):
                self.assertTrue(self.call(b"SET", b"k", b"new", *option).startswith(b"-ERR "))
                self.assertEqual(self.store.get(b"k"), b"old")
        for args in ([], [b"GET"], [b"HELLO", b"3"], [b"SELECT", b"1"],
                     [b"EXPIRE", b"k", b"9" * 100], [b"PING", b"a", b"b"]):
            self.assertTrue(dispatch(self.store, args).startswith(b"-ERR "))
