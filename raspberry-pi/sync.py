from __future__ import annotations

import argparse
import asyncio
import contextlib
import getpass
import logging
import math
import os
import re
import signal
import sqlite3
import sys
import time
import tomllib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


HEADER = bytes.fromhex("10 00 00 c5")
NOTIFY_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"


@dataclass(frozen=True)
class Weight:
    kilograms: float
    stable: bool


def decode_weight(frame: bytes) -> Weight | None:
    if len(frame) < 14 or not frame.startswith(HEADER):
        return None
    if frame[4] != len(frame) or sum(frame[4:-1]) & 255 != frame[-1]:
        return None
    if frame[5:7] != bytes([3, 0x80]):
        return None
    raw = int.from_bytes(frame[7:9], "big")
    if raw == 65535:
        return None
    division, unit = frame[11] >> 4, frame[11] & 15
    if unit not in (0, 1, 2, 3):
        return None
    if unit in (2, 3):
        pounds_raw = int.from_bytes(frame[9:11], "big")
        if pounds_raw == 65535:
            return None
        kilograms = pounds_raw / (100 if division == 2 else 10) * 0.4535924
    else:
        kilograms = raw / (100 if division in (1, 2) else 10)
    return Weight(round(kilograms, 4), frame[12] in (0xAA, 0xBA))


class Decoder:
    def __init__(self) -> None:
        self.buffer = bytearray()

    def feed(self, notification: bytes) -> list[Weight]:
        self.buffer.extend(notification)
        results = []
        while self.buffer:
            offset = self.buffer.find(HEADER)
            if offset < 0:
                self.buffer = self.buffer[-3:]
                break
            del self.buffer[:offset]
            if len(self.buffer) < 5:
                break
            length = self.buffer[4]
            if length < 8:
                del self.buffer[0]
                continue
            if len(self.buffer) < length:
                break
            frame = bytes(self.buffer[:length])
            if sum(frame[4:-1]) & 255 != frame[-1]:
                del self.buffer[0]
                continue
            del self.buffer[:length]
            weight = decode_weight(frame)
            if weight is not None:
                results.append(weight)
        return results


@dataclass(frozen=True)
class Config:
    address: str
    state_dir: Path
    dry_run: bool = True
    min_kg: float = 30
    max_kg: float = 200
    duplicate_seconds: float = 180
    scan_seconds: float = 15


def load_config(path: Path) -> Config:
    with path.open("rb") as handle:
        values = tomllib.load(handle)
    allowed = set(Config.__dataclass_fields__)
    if values.keys() - allowed:
        raise ValueError("Unknown configuration option")
    values["state_dir"] = Path(values.get("state_dir", "~/.local/state/senssun-sync")).expanduser()
    config = Config(**values)
    if not isinstance(config.address, str) or not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", config.address):
        raise ValueError("Set address to the scale's colon-separated Bluetooth MAC address")
    if not isinstance(config.dry_run, bool):
        raise ValueError("dry_run must be true or false")
    for name in ("min_kg", "max_kg", "duplicate_seconds", "scan_seconds"):
        value = getattr(config, name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be a finite number")
    if not 0 < config.min_kg < config.max_kg <= 500:
        raise ValueError("Require 0 < min_kg < max_kg <= 500")
    if config.duplicate_seconds < 1 or not 1 <= config.scan_seconds <= 120:
        raise ValueError("Invalid duplicate or scan interval")
    if not config.state_dir.is_absolute():
        raise ValueError("state_dir must be absolute (or start with ~)")
    return config


class Store:
    def __init__(self, directory: Path, cross_thread: bool = False) -> None:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        self.connection = sqlite3.connect(
            directory / "weights.sqlite3", check_same_thread=not cross_thread
        )
        self.connection.row_factory = sqlite3.Row
        with self.connection:
            self.connection.execute(
                "CREATE TABLE IF NOT EXISTS weights ("
                "id INTEGER PRIMARY KEY, measured_at TEXT NOT NULL, "
                "epoch REAL NOT NULL, kg REAL NOT NULL, state TEXT NOT NULL)"
            )
        (directory / "weights.sqlite3").chmod(0o600)

    def enqueue(self, weight: Weight, config: Config, epoch: float | None = None) -> bool:
        if not weight.stable or not config.min_kg <= weight.kilograms <= config.max_kg:
            return False
        epoch = time.time() if epoch is None else epoch
        with self.connection:
            recent = self.connection.execute(
                "SELECT 1 FROM weights WHERE ABS(epoch - ?) < ? AND ABS(kg - ?) < 0.02 LIMIT 1",
                (epoch, config.duplicate_seconds, weight.kilograms),
            ).fetchone()
            if recent:
                return False
            self.connection.execute(
                "INSERT INTO weights(measured_at, epoch, kg, state) VALUES (?, ?, ?, 'pending')",
                (datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="seconds"),
                 epoch, weight.kilograms),
            )
        return True

    def next_pending(self):
        return self.connection.execute(
            "SELECT * FROM weights WHERE state = 'pending' ORDER BY id LIMIT 1"
        ).fetchone()

    def mark(self, identifier: int, state: str) -> None:
        with self.connection:
            self.connection.execute("UPDATE weights SET state = ? WHERE id = ?", (state, identifier))

    def recover(self) -> None:
        with self.connection:
            self.connection.execute("UPDATE weights SET state = 'uncertain' WHERE state = 'sending'")

    def resolve(self, identifier: int, state: str) -> None:
        with self.connection:
            changed = self.connection.execute(
                "UPDATE weights SET state = ? WHERE id = ? AND state = 'uncertain'", (state, identifier)
            ).rowcount
        if changed != 1:
            raise ValueError("That ID is not an uncertain upload")

    def rows(self):
        return self.connection.execute("SELECT * FROM weights ORDER BY id DESC LIMIT 50").fetchall()

    def close(self) -> None:
        self.connection.close()


class GarminUploader:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.client = None

    def prepare(self) -> None:
        if self.client is None:
            from garminconnect import Garmin

            client = Garmin(retry_attempts=0)
            client.login(str(self.directory))
            self.client = client

    def send(self, row) -> None:
        if self.client is None:
            raise RuntimeError("Garmin session not prepared")
        self.client.add_weigh_in(weight=row["kg"], unitKey="kg", timestamp=row["measured_at"])

    def reset(self) -> None:
        self.client = None


def upload_one(store: Store, uploader) -> str:
    row = store.next_pending()
    if row is None:
        return "empty"
    try:
        uploader.prepare()
    except Exception as error:
        logging.warning("Garmin login unavailable (%s); queue retained. Run login if needed.",
                        type(error).__name__)
        uploader.reset()
        return "retry"
    store.mark(row["id"], "sending")
    try:
        uploader.send(row)
    except Exception as error:
        store.mark(row["id"], "uncertain")
        uploader.reset()
        logging.error("Upload %s needs review (%s). Check Garmin, then use resolve.",
                      row["id"], type(error).__name__)
        return "uncertain"
    store.mark(row["id"], "sent")
    logging.info("Upload %s completed", row["id"])
    return "sent"


@contextlib.contextmanager
def process_lock(directory: Path):
    import fcntl

    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    with (directory / "service.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Service is running; stop it before login or resolve") from None
        yield


async def pause(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except TimeoutError:
        pass


async def collect(config: Config, store: Store, stop: asyncio.Event) -> None:
    from bleak import BleakClient, BleakScanner

    while not stop.is_set():
        try:
            logging.info("Waiting for configured scale")
            device = await BleakScanner.find_device_by_address(
                config.address, timeout=config.scan_seconds
            )
            if device is None:
                await pause(stop, 2)
                continue
            decoder = Decoder()
            last_packet = time.monotonic()
            packet_count = 0
            weight_count = 0

            def notification(_characteristic, data):
                nonlocal last_packet, packet_count, weight_count
                last_packet = time.monotonic()
                packet_count += 1
                for weight in decoder.feed(bytes(data)):
                    weight_count += 1
                    if config.dry_run:
                        logging.info("Dry run: %.4f kg, stable=%s (not queued)",
                                     weight.kilograms, weight.stable)
                    elif store.enqueue(weight, config):
                        logging.info("Stable weight saved to queue")

            async with BleakClient(device, timeout=20) as client:
                await client.start_notify(NOTIFY_UUID, notification)
                logging.info("Subscribed to FFF1; no scale commands sent")
                while client.is_connected and not stop.is_set():
                    if time.monotonic() - last_packet > 60:
                        break
                    await pause(stop, 1)
            if packet_count and not weight_count:
                logging.warning("Notifications received but no legacy weight decoded; protocol unverified")
        except Exception as error:
            logging.warning("Bluetooth unavailable (%s); reconnecting", type(error).__name__)
        await pause(stop, 5)


async def upload_loop(config: Config, store: Store, stop: asyncio.Event) -> None:
    uploader = GarminUploader(config.state_dir / "tokens")
    delay = 30
    while not stop.is_set():
        if config.dry_run:
            await pause(stop, 5)
            continue
        task = asyncio.create_task(asyncio.to_thread(upload_one, store, uploader))
        try:
            result = await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        if result == "retry":
            await pause(stop, delay)
            delay = min(delay * 2, 1800)
        else:
            delay = 30
            await pause(stop, 5)


async def run_service(config: Config) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)
    reader_store = Store(config.state_dir)
    writer_store = Store(config.state_dir, cross_thread=True)
    reader_store.recover()
    logging.info("Mode: %s", "DRY RUN (no Garmin access)" if config.dry_run else "LIVE UPLOAD")
    try:
        async with asyncio.TaskGroup() as group:
            group.create_task(collect(config, reader_store, stop))
            group.create_task(upload_loop(config, writer_store, stop))
    finally:
        reader_store.close()
        writer_store.close()


async def scan(seconds: float) -> None:
    from bleak import BleakScanner

    devices = await BleakScanner.discover(timeout=seconds, return_adv=True)
    for device, advertisement in devices.values():
        print(f"{device.address}\t{advertisement.local_name or device.name or '(unnamed)'}"
              f"\t{','.join(advertisement.service_uuids)}")


def login(config: Config) -> None:
    from garminconnect import Garmin

    tokens = config.state_dir / "tokens"
    tokens.mkdir(parents=True, exist_ok=True, mode=0o700)
    tokens.chmod(0o700)
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    client = Garmin(email, password, prompt_mfa=lambda: getpass.getpass("Garmin MFA code: "),
                    retry_attempts=0)
    client.login(str(tokens))
    client.client.dump(str(tokens))
    print("Login complete. Tokens saved locally; password is not saved by this service.")


def main() -> None:
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for name in ("garminconnect", "bleak", "urllib3", "requests", "curl_cffi"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    parser = argparse.ArgumentParser(description="Senssun stable weight to Garmin (Raspberry Pi)")
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.toml"))
    commands = parser.add_subparsers(dest="command", required=True)
    scan_parser = commands.add_parser("scan", help="List nearby BLE addresses; no Garmin access")
    scan_parser.add_argument("--seconds", type=float, default=15)
    for command in ("login", "run", "status"):
        commands.add_parser(command)
    resolve_parser = commands.add_parser("resolve", help="Resolve an uncertain upload after checking Garmin")
    resolve_parser.add_argument("id", type=int)
    resolve_parser.add_argument("--as", dest="state", required=True,
                                choices=("sent", "pending", "discarded"))
    args = parser.parse_args()
    if args.command == "scan":
        if not math.isfinite(args.seconds) or not 1 <= args.seconds <= 120:
            parser.error("scan seconds must be between 1 and 120")
        asyncio.run(scan(args.seconds))
        return
    config = load_config(args.config)
    if args.command == "status":
        store = Store(config.state_dir)
        try:
            for row in store.rows():
                print(f"{row['id']}\t{row['state']}\t{row['measured_at']}\t{row['kg']:.4f} kg")
        finally:
            store.close()
        return
    with process_lock(config.state_dir):
        if args.command == "login":
            login(config)
        elif args.command == "run":
            asyncio.run(run_service(config))
        else:
            store = Store(config.state_dir)
            try:
                store.recover()
                store.resolve(args.id, args.state)
            finally:
                store.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as failure:
        print(f"Stopped ({type(failure).__name__}). Check configuration, dependencies, and login.",
              file=sys.stderr)
        sys.exit(1)