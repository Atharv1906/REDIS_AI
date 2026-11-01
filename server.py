"""Educational RESP2 cache server. Not a production Redis replacement."""

import argparse
import asyncio
import logging
from contextlib import suppress

from resp import ProtocolError, bulk, error, integer, read_request
from store import Store

LOG = logging.getLogger(__name__)
OK = b"+OK\r\n"
INT_MAX = 2**63 - 1


def number(raw: bytes) -> int:
    digits = raw[1:] if raw.startswith(b"-") else raw
    if not digits or not digits.isdigit() or len(digits) > 19:
        raise ValueError("value is not an integer or out of range")
    value = int(raw)
    if not -(2**63) <= value <= INT_MAX:
        raise ValueError("value is not an integer or out of range")
    return value


def duration(raw: bytes, seconds: bool) -> int:
    value = number(raw)
    if seconds:
        value *= 1000
    if not -(2**63) <= value <= INT_MAX:
        raise ValueError("expiration is out of range")
    return value


def dispatch(store: Store, args: list[bytes]) -> bytes:
    try:
        if not args:
            raise ValueError("empty command")
        command, *params = args
        command = command.upper()
        count = len(params)
        if command == b"PING" and count in (0, 1):
            return bulk(params[0]) if params else b"+PONG\r\n"
        if command == b"ECHO" and count == 1:
            return bulk(params[0])
        if command == b"GET" and count == 1:
            return bulk(store.get(params[0]))
        if command == b"SET" and count >= 2:
            key, value, *options = params
            ttl_ms = None
            condition = None
            index = 0
            while index < len(options):
                option = options[index].upper()
                if option in (b"NX", b"XX") and condition is None:
                    condition = option
                elif option in (b"EX", b"PX") and ttl_ms is None:
                    index += 1
                    if index >= len(options):
                        raise ValueError("syntax error")
                    ttl_ms = duration(options[index], option == b"EX")
                    if ttl_ms <= 0:
                        raise ValueError("invalid expire time in SET")
                else:
                    raise ValueError("syntax error")
                index += 1
            return OK if store.set(key, value, ttl_ms, condition) else bulk(None)
        if command in (b"DEL", b"EXISTS") and count >= 1:
            if command == b"EXISTS":
                return integer(sum(store.exists(key) for key in params))
            deleted = 0
            for key in params:
                if store.exists(key):
                    deleted += store.delete(key)
            return integer(deleted)
        if command in (b"TTL", b"PTTL") and count == 1:
            return integer(store.ttl(params[0], command == b"PTTL"))
        if command in (b"EXPIRE", b"PEXPIRE") and count == 2:
            ttl_ms = duration(params[1], command == b"EXPIRE")
            return integer(store.expire(params[0], ttl_ms))
        if command == b"PERSIST" and count == 1:
            return integer(store.persist(params[0]))
        if command == b"DBSIZE" and count == 0:
            store.sweep()
            return integer(len(store.data))
        if command == b"FLUSHDB" and count == 0:
            store.clear()
            return OK
        if command == b"SELECT" and count == 1:
            if number(params[0]) != 0:
                raise ValueError("only database 0 is supported")
            return OK
        if (
            command == b"CLIENT"
            and count == 3
            and params[0].upper() == b"SETINFO"
            and params[1].upper() in (b"LIB-NAME", b"LIB-VER")
        ):
            return OK
        raise ValueError("unknown command, unsupported option, or wrong argument count")
    except ValueError as exc:
        return error(str(exc))


class CacheServer:
    def __init__(
        self,
        store: Store | None = None,
        max_clients: int = 100,
        timeout: float = 30,
    ) -> None:
        if max_clients <= 0 or timeout <= 0:
            raise ValueError("client limit and timeout must be positive")
        self.store = store if store is not None else Store()
        self.max_clients = max_clients
        self.timeout = timeout
        self.listener: asyncio.Server | None = None
        self.clients: set[asyncio.StreamWriter] = set()
        self.connections: set[asyncio.StreamWriter] = set()
        self.tasks: set[asyncio.Task[None]] = set()
        self.janitor: asyncio.Task[None] | None = None
        self.closing = False

    async def start(self, host: str = "127.0.0.1", port: int = 6379) -> int:
        self.listener = await asyncio.start_server(self.accept, host, port, limit=128)
        self.janitor = asyncio.create_task(self.cleanup())
        return int(self.listener.sockets[0].getsockname()[1])

    async def cleanup(self) -> None:
        while True:
            await asyncio.sleep(1)
            self.store.sweep(128)

    def accept(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if self.closing:
            writer.close()
            return
        admitted = len(self.clients) < self.max_clients
        if admitted:
            self.clients.add(writer)
        self.connections.add(writer)
        task = asyncio.create_task(self.handle(reader, writer, admitted))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, admitted: bool
    ) -> None:
        try:
            if not admitted:
                writer.write(error("maximum clients reached"))
                await asyncio.wait_for(writer.drain(), self.timeout)
                return
            while True:
                try:
                    args = await asyncio.wait_for(read_request(reader), self.timeout)
                except asyncio.IncompleteReadError:
                    if reader.at_eof():
                        LOG.debug("client disconnected during request or at EOF")
                    return
                except ProtocolError as exc:
                    writer.write(error(str(exc)))
                    await asyncio.wait_for(writer.drain(), self.timeout)
                    return
                except TimeoutError:
                    writer.write(error("request timed out"))
                    await asyncio.wait_for(writer.drain(), self.timeout)
                    return
                writer.write(dispatch(self.store, args))
                await asyncio.wait_for(writer.drain(), self.timeout)
        except (ConnectionError, TimeoutError):
            LOG.debug("client disconnected or exceeded write timeout")
        finally:
            self.clients.discard(writer)
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), self.timeout)
            except (ConnectionError, TimeoutError):
                LOG.debug("connection closed before shutdown completed")
            finally:
                self.connections.discard(writer)

    async def close(self) -> None:
        self.closing = True
        if self.listener is not None:
            self.listener.close()
        if self.janitor is not None:
            self.janitor.cancel()
            with suppress(asyncio.CancelledError):
                await self.janitor
        tasks = list(self.tasks)
        for writer in self.connections:
            writer.close()
        for task in tasks:
            task.cancel()
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    LOG.error("client task failed during shutdown: %r", result)
        for writer in list(self.connections):
            try:
                await asyncio.wait_for(writer.wait_closed(), self.timeout)
            except (ConnectionError, TimeoutError):
                LOG.debug("connection closed before shutdown completed")
        self.connections.clear()
        self.clients.clear()
        if self.listener is not None:
            await self.listener.wait_closed()


async def run(host: str, port: int, max_bytes: int, max_clients: int, timeout: float) -> None:
    server = CacheServer(Store(max_bytes), max_clients, timeout)
    actual_port = await server.start(host, port)
    LOG.info("Listening on %s:%d (volatile, unauthenticated RESP2)", host, actual_port)
    try:
        assert server.listener is not None
        await server.listener.serve_forever()
    finally:
        await server.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6379)
    parser.add_argument("--max-bytes", type=int, default=16 * 1024 * 1024)
    parser.add_argument("--max-clients", type=int, default=100)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    if args.max_bytes <= 0 or args.max_clients <= 0 or not 0 < args.timeout < float("inf"):
        parser.error("limits and timeout must be positive and finite")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        asyncio.run(run(args.host, args.port, args.max_bytes, args.max_clients, args.timeout))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
