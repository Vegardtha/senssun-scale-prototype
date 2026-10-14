import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).parent))

from sync import (
    NOTIFY_UUID, Config, Decoder, GarminUploader, Store, Weight, collect,
    decode_weight, load_config, upload_loop, upload_one,
)


class DecoderTests(unittest.TestCase):
    def test_shared_synthetic_fixtures(self):
        fixture = Path(__file__).parent.parent / "fixtures" / "synthetic-layout.json"
        for case in json.loads(fixture.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case=case["name"]):
                decoder = Decoder()
                actual = []
                for notification in case["notifications"]:
                    actual.extend(decoder.feed(bytes.fromhex(notification)))
                expected = [
                    item for item in case["expected"]
                    if item.get("type") == "realtime-weight"
                    and "weight" in item.get("measurements", {})
                ]
                self.assertEqual(len(actual), len(expected))
                for actual_weight, expected_weight in zip(actual, expected):
                    self.assertAlmostEqual(
                        actual_weight.kilograms, expected_weight["measurements"]["weight"], 4
                    )
                    if "stable" in expected_weight.get("fields", {}):
                        self.assertEqual(actual_weight.stable, expected_weight["fields"]["stable"])

    def test_split_header_and_frame(self):
        decoder = Decoder()
        frame = bytes.fromhex("10 00 00 C5 0E 03 80 1C 43 06 3B 11 AA EC")
        self.assertEqual(decoder.feed(b"noise" + frame[:2]), [])
        self.assertEqual(decoder.feed(frame[2:9]), [])
        self.assertEqual(decoder.feed(frame[9:]), [Weight(72.35, True)])

    def test_corrupt_then_valid_frame(self):
        decoder = Decoder()
        valid = bytes.fromhex("10 00 00 C5 0E 03 80 1C 43 06 3B 11 AA EC")
        corrupt = valid[:-1] + b"\x00"
        self.assertEqual(decoder.feed(corrupt + valid), [Weight(72.35, True)])

    def test_reject_short_or_bad_frames(self):
        self.assertIsNone(decode_weight(b""))
        self.assertIsNone(decode_weight(bytes.fromhex("10 00 00 C5 08 03 83 8E")))


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.config = Config("AA:BB:CC:DD:EE:FF", self.directory, dry_run=False)
        self.store = Store(self.directory)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def test_only_stable_in_range_and_no_duplicates(self):
        self.assertFalse(self.store.enqueue(Weight(72.35, False), self.config, 1000))
        self.assertFalse(self.store.enqueue(Weight(0, True), self.config, 1000))
        self.assertFalse(self.store.enqueue(Weight(float("nan"), True), self.config, 1000))
        self.assertTrue(self.store.enqueue(Weight(72.35, True), self.config, 1000))
        self.assertFalse(self.store.enqueue(Weight(72.35, True), self.config, 1001))
        self.store.close()
        self.store = Store(self.directory)
        self.assertFalse(self.store.enqueue(Weight(72.35, True), self.config, 1002))
        self.assertTrue(self.store.enqueue(Weight(72.35, True), self.config, 2000))

    def test_success_is_not_repeated(self):
        self.store.enqueue(Weight(72.35, True), self.config, 1000)
        uploader = Mock()
        self.assertEqual(upload_one(self.store, uploader), "sent")
        self.assertEqual(upload_one(self.store, uploader), "empty")
        uploader.send.assert_called_once()
        self.assertEqual(self.store.rows()[0]["measured_at"], "1970-01-01T00:16:40+00:00")

    def test_login_failure_retains_pending(self):
        self.store.enqueue(Weight(72.35, True), self.config, 1000)
        uploader = Mock()
        uploader.prepare.side_effect = RuntimeError("secret must not be logged")
        with self.assertLogs(level="WARNING") as captured:
            self.assertEqual(upload_one(self.store, uploader), "retry")
        self.assertNotIn("secret must not be logged", " ".join(captured.output))
        self.assertEqual(self.store.rows()[0]["state"], "pending")
        uploader.send.assert_not_called()

    def test_ambiguous_upload_requires_review(self):
        self.store.enqueue(Weight(72.35, True), self.config, 1000)
        uploader = Mock()
        uploader.send.side_effect = TimeoutError()
        with self.assertLogs(level="ERROR"):
            self.assertEqual(upload_one(self.store, uploader), "uncertain")
        self.assertEqual(upload_one(self.store, uploader), "empty")
        self.store.resolve(1, "sent")
        self.assertEqual(self.store.rows()[0]["state"], "sent")

    def test_crash_during_send_is_not_retried(self):
        self.store.enqueue(Weight(72.35, True), self.config, 1000)
        self.store.mark(1, "sending")
        self.store.recover()
        self.assertEqual(self.store.rows()[0]["state"], "uncertain")
        self.store.resolve(1, "pending")
        self.assertIsNotNone(self.store.next_pending())
        with self.assertRaises(ValueError):
            self.store.resolve(1, "sent")

    def test_config_defaults_and_validation(self):
        path = self.directory / "config.toml"
        path.write_text('address = "AA:BB:CC:DD:EE:FF"\n', encoding="utf-8")
        self.assertTrue(load_config(path).dry_run)
        for setting in ('dry_run = "false"', 'min_kg = nan', 'scan_seconds = 0', 'surprise = 1'):
            path.write_text('address = "AA:BB:CC:DD:EE:FF"\n' + setting, encoding="utf-8")
            with self.subTest(setting=setting), self.assertRaises((ValueError, TypeError)):
                load_config(path)


class GarminTests(unittest.TestCase):
    def test_tokens_and_weight_only_contract(self):
        factory = Mock()
        client = factory.return_value
        uploader = GarminUploader(Path("test-tokens"))
        with patch.dict(sys.modules, {"garminconnect": SimpleNamespace(Garmin=factory)}):
            uploader.prepare()
            uploader.prepare()
        factory.assert_called_once_with(retry_attempts=0)
        client.login.assert_called_once_with("test-tokens")
        uploader.send({"kg": 72.35, "measured_at": "2026-10-14T06:00:00+00:00"})
        client.add_weigh_in.assert_called_once_with(
            weight=72.35, unitKey="kg", timestamp="2026-10-14T06:00:00+00:00"
        )
        uploader.reset()
        with self.assertRaises(RuntimeError):
            uploader.send({})


class BluetoothTests(unittest.IsolatedAsyncioTestCase):
    async def test_capture_and_dry_run(self):
        for dry_run in (True, False):
            with self.subTest(dry_run=dry_run), tempfile.TemporaryDirectory() as directory:
                config = Config("AA:BB:CC:DD:EE:FF", Path(directory), dry_run=dry_run)
                store = Store(config.state_dir)
                stop = asyncio.Event()
                client = AsyncMock()
                client.is_connected = True
                client.__aenter__.return_value = client

                async def notify(uuid, callback):
                    self.assertEqual(uuid, NOTIFY_UUID)
                    callback(None, bytes.fromhex("10 00 00 C5 0E 03 80 1C 43 06 3B 11 AA EC"))
                    stop.set()

                client.start_notify.side_effect = notify
                device = object()
                scanner = SimpleNamespace(find_device_by_address=AsyncMock(return_value=device))
                factory = Mock(return_value=client)
                bleak = SimpleNamespace(BleakClient=factory, BleakScanner=scanner)
                try:
                    with patch.dict(sys.modules, {"bleak": bleak}):
                        await collect(config, store, stop)
                    scanner.find_device_by_address.assert_awaited_once_with(config.address, timeout=15)
                    factory.assert_called_once_with(device, timeout=20)
                    client.write_gatt_char.assert_not_called()
                    self.assertEqual(len(store.rows()), 0 if dry_run else 1)
                finally:
                    store.close()

    async def test_dry_run_never_prepares_garmin(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Config("AA:BB:CC:DD:EE:FF", Path(directory))
            store = Store(config.state_dir)
            store.enqueue(Weight(72.35, True), config)
            stop = asyncio.Event()

            async def finish(_stop, _seconds):
                stop.set()

            try:
                with patch("sync.GarminUploader") as uploader, patch("sync.pause", finish):
                    await upload_loop(config, store, stop)
                uploader.return_value.prepare.assert_not_called()
                self.assertEqual(store.rows()[0]["state"], "pending")
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()