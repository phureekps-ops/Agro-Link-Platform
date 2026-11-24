"""ทดสอบโปรแกรม Gateway โดยไม่ต้องมีอุปกรณ์จริง:  python3 -m unittest discover -s tests -v  (ในโฟลเดอร์ gateway/)"""
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agrolink_gw import config as C  # noqa: E402
from agrolink_gw import devices as D  # noqa: E402
from agrolink_gw import sim  # noqa: E402
from agrolink_gw.store import Store  # noqa: E402
from agrolink_gw.uplink import Uplink  # noqa: E402

KEY = "dk_" + "a" * 48


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(fn, timeout=10, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


class ConfigTest(unittest.TestCase):
    def test_example_files_load(self):
        here = os.path.join(os.path.dirname(__file__), "..")
        c = C.load(os.path.join(here, "config.example.toml"))
        self.assertEqual(c["scales"][0]["channel"], "scale1")
        self.assertEqual(c["modbus"][0]["sensors"][0]["scale"], 0.1)
        self.assertTrue(C.load(os.path.join(here, "config.sim.toml"))["api_base"].startswith("http://localhost"))

    def test_rejects_bad_values(self):
        with self.assertRaisesRegex(C.ConfigError, "channel"):
            C.parse({"scale": [{"channel": "Scale 1", "port": "/dev/ttyS1"}]})
        with self.assertRaisesRegex(C.ConfigError, "ซ้ำ"):
            C.parse({"scale": [{"channel": "a", "port": "x"}], "analyzer": [{"channel": "a", "port": "y", "fields": ["fat_pct"]}]})
        with self.assertRaisesRegex(C.ConfigError, "https"):
            C.parse({"agrolink": {"api_base": "http://example.com"}})
        with self.assertRaisesRegex(C.ConfigError, "fields"):
            C.parse({"analyzer": [{"channel": "a", "port": "y"}]})
        with self.assertRaisesRegex(C.ConfigError, "temp_c หรือ level_kg"):
            C.parse({"modbus": [{"port": "p", "sensor": [{"channel": "t", "field": "pressure"}]}]})


class ScaleParserTest(unittest.TestCase):
    def test_stable_flag(self):
        p = D.ScaleParser(C.DEFAULT_SCALE_PATTERN)
        self.assertEqual(p.feed("US,GS,+0012.30kg"), (12.3, False))
        self.assertEqual(p.feed("ST,GS,+0025.45kg"), (25.45, True))
        self.assertEqual(p.feed("ST,NT, +0001.00 kg"), (1.0, True))
        self.assertIsNone(p.feed("garbage"))

    def test_stability_from_repeated_values(self):
        p = D.ScaleParser(r"(?P<weight>\d+\.\d+)", window=3, tolerance=0.05)
        self.assertEqual(p.feed("W 20.00"), (20.0, False))
        self.assertEqual(p.feed("W 20.02"), (20.02, False))
        self.assertEqual(p.feed("W 20.03"), (20.03, True))
        self.assertEqual(p.feed("W 21.00"), (21.0, False))


class AnalyzerParseTest(unittest.TestCase):
    def test_csv(self):
        c = {"format": "csv", "delimiter": ",", "fields": ["sample_no", "fat_pct", "-", "snf_pct", "added_water_pct"], "skip_prefix": ["#"]}
        r = D.parse_analysis("S0012, 3.85 ,xx, 8,42 ,0.0", {**c, "delimiter": ","})
        self.assertEqual(r["sample_no"], "S0012")
        self.assertEqual(r["fat_pct"], 3.85)
        self.assertEqual(r["snf_pct"], 8.0)  # "8" — คอลัมน์ "8,42" ถูกแยกด้วย delimiter
        c2 = {**c, "delimiter": ";", "fields": ["sample_no", "fat_pct", "snf_pct"]}
        self.assertEqual(D.parse_analysis("S1;3,85;8,42", c2), {"sample_no": "S1", "fat_pct": 3.85, "snf_pct": 8.42})
        self.assertIsNone(D.parse_analysis("# header line", c))
        self.assertIsNone(D.parse_analysis("S1,,,", c))  # ไม่มีค่าหลัก

    def test_keyvalue_and_regex(self):
        kv = {"format": "keyvalue", "keys": {"Fat": "fat_pct", "SNF": "snf_pct", "Added Water": "added_water_pct", "ID": "member_code"}}
        self.assertEqual(D.parse_analysis("Fat=3.90 SNF: 8.51 Added Water=2.5 Temp=9", kv), {"fat_pct": 3.9, "snf_pct": 8.51, "added_water_pct": 2.5})
        rx = {"format": "regex", "pattern": r"F(?P<fat_pct>[\d.]+) S(?P<snf_pct>[\d.]+) M(?P<member_code>\w+)"}
        self.assertEqual(D.parse_analysis("F3.7 S8.3 MA001", rx), {"fat_pct": 3.7, "snf_pct": 8.3, "member_code": "A001"})


class ModbusTest(unittest.TestCase):
    def test_crc_and_frames(self):
        # ตัวอย่างมาตรฐาน: slave 1, fn 3, reg 0, count 1 → CRC 84 0A
        self.assertEqual(D.rtu_request(1, 3, 0, 1).hex(), "010300000001840a")
        resp = bytes([1, 4, 2, 0x00, 0x26])
        resp += D.crc16(resp)
        self.assertEqual(D.decode(D.rtu_parse(resp, 1, 4, 1), "int16"), 38)
        with self.assertRaises(D.ModbusError):
            D.rtu_parse(resp[:-1] + b"\x00", 1, 4, 1)
        err = bytes([1, 0x84, 2])
        with self.assertRaisesRegex(D.ModbusError, "exception_2"):
            D.rtu_parse(err + D.crc16(err), 1, 4, 1)
        f = struct.pack(">f", 1234.5)
        self.assertAlmostEqual(D.decode(f, "float32"), 1234.5)
        self.assertAlmostEqual(D.decode(f[2:] + f[:2], "float32", "little"), 1234.5)
        self.assertEqual(D.decode(struct.pack(">h", -15), "int16"), -15)

    def test_bus_against_simulator(self):
        ports = [free_port() for _ in range(3)]
        servers = sim.start(*ports, analyzer_every_s=2)
        try:
            got = []
            bus = {"port": f"socket://127.0.0.1:{ports[2]}", "baud": 9600, "bytesize": 8, "parity": "N", "stopbits": 1, "encoding": "ascii",
                   "interval_s": 0.3, "send_every_s": 0, "timeout_s": 1.0, "sensors": [
                       {"channel": "tank1", "field": "temp_c", "slave": 1, "function": 4, "register": 1, "type": "int16", "scale": 0.1, "offset": 0, "word_order": "big"},
                       {"channel": "tank1", "field": "level_kg", "slave": 1, "function": 3, "register": 10, "type": "float32", "scale": 1, "offset": 0, "word_order": "big"},
                       {"channel": "tank2", "field": "temp_c", "slave": 9, "function": 4, "register": 1, "type": "int16", "scale": 0.1, "offset": 0, "word_order": "big"},
                   ]}
            b = D.ModbusBus(bus, lambda ch, v: got.append((ch, v)))
            b.start()
            self.assertTrue(wait_for(lambda: any(ch == "tank1" and "level_kg" in v for ch, v in got)))
            ch, v = next(x for x in got if x[0] == "tank1" and "level_kg" in x[1])
            self.assertTrue(1.5 <= v["temp_c"] <= 10, v)
            self.assertGreaterEqual(v["level_kg"], 1200)
            self.assertIn("tank2.temp_c", wait_for(lambda: b.errors))  # slave 9 ไม่มีจริง → error แต่ไม่ล้ม
            b.stop()
        finally:
            for s in servers:
                s.shutdown()


class StoreTest(unittest.TestCase):
    def test_outbox_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "gw.db")
            s = Store(p)
            e1 = s.enqueue("intake", channel="scale1", member_code="A001", weight_kg=20.5)
            s.enqueue("reading", channel="tank1", temp_c=3.9)
            s.mark(e1["id"], "ok", result={"x": 1})
            s2 = Store(p)  # เปิดใหม่เหมือนเครื่องรีสตาร์ต
            self.assertEqual([e["type"] for e in s2.pending()], ["reading"])
            self.assertEqual(s2.counts(), {"ok": 1, "pending": 1})
            self.assertRegex(e1["id"], r"^int_[0-9a-f]{32}$")
            s2.set_members([{"member_code": "A001", "full_name": "สมชาย", "withdrawal": True}])
            self.assertEqual(s2.member("A001"), {"code": "A001", "name": "สมชาย", "withdrawal": True})
            self.assertEqual(len(s2.search_members("สม")), 1)


class FakeAgroLink:
    """เซิร์ฟเวอร์ AgroLink จำลอง: จำรหัสเหตุการณ์ (กันซ้ำ) และตั้งให้ล่ม/ตอบ retry ได้"""

    def __init__(self):
        self.seen = {}
        self.batches = []
        self.down = False
        self.retry_once = set()
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                if self.headers.get("X-Device-Key") != KEY:
                    return self._json(401, {"error": "invalid_device_key"})
                return self._json(200, {"server_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "coop": "สหกรณ์ทดสอบ",
                                        "center": {"name": "ศูนย์ 1"}, "channels": [{"channel": "scale1", "name": "ชั่ง"}],
                                        "members": [{"member_code": "A001", "full_name": "สมชาย", "withdrawal": False},
                                                    {"member_code": "B002", "full_name": "สมหญิง", "withdrawal": True}]})

            def do_POST(self):  # noqa: N802
                if outer.down:
                    return self._json(503, {"error": "down"})
                if self.headers.get("X-Device-Key") != KEY:
                    return self._json(401, {"error": "invalid_device_key"})
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.batches.append(body)
                res = []
                for ev in body["events"]:
                    if ev["id"] in outer.retry_once:
                        outer.retry_once.discard(ev["id"])
                        res.append({"id": ev["id"], "status": "retry"})
                    elif ev["id"] in outer.seen:
                        res.append({"id": ev["id"], "status": "duplicate", "ok": True, "data": outer.seen[ev["id"]]})
                    elif ev.get("member_code") == "ZZZ":
                        res.append({"id": ev["id"], "status": "error", "error": "member_not_found"})
                    else:
                        outer.seen[ev["id"]] = {"ok": ev["type"]}
                        res.append({"id": ev["id"], "status": "ok", "data": outer.seen[ev["id"]]})
                return self._json(200, {"server_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "results": res})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


def make_cfg(d, api, **over):
    raw = {"agrolink": {"api_base": api, "key_file": os.path.join(d, "device.key"), "send_every_s": 0.2, "heartbeat_s": 1},
           "gateway": {"data_dir": d, "ui_port": 0}}
    for k, v in over.items():
        raw[k] = v
    return C.parse(raw)


class UplinkTest(unittest.TestCase):
    def test_ok_error_retry_outage_and_no_double_send(self):
        fake = FakeAgroLink()
        with tempfile.TemporaryDirectory() as d:
            cfg = make_cfg(d, fake.url)
            st = Store(os.path.join(d, "gw.db"))
            up = Uplink(cfg, st, lambda: KEY)
            a = st.enqueue("intake", channel="scale1", member_code="A001", weight_kg=20)
            b = st.enqueue("intake", channel="scale1", member_code="ZZZ", weight_kg=5)
            c = st.enqueue("reading", channel="tank1", temp_c=4)
            fake.retry_once.add(c["id"])
            self.assertEqual(up.send_once(), 3)
            self.assertEqual(st.counts(), {"ok": 1, "error": 1, "pending": 1})
            self.assertEqual(st.recent("intake")[0]["_error"], "member_not_found")
            up.send_once()  # c ถูกส่งซ้ำและสำเร็จ
            self.assertEqual(st.counts(), {"ok": 2, "error": 1})
            # เน็ตล่ม: ข้อมูลอยู่ในคิว
            fake.down = True
            st.enqueue("intake", channel="scale1", member_code="A001", weight_kg=18)
            with self.assertRaises(IOError):
                up.send_once()
            self.assertEqual(st.counts()["pending"], 1)
            fake.down = False
            up.send_once()
            self.assertEqual(st.counts(), {"ok": 3, "error": 1})
            # ส่งเหตุการณ์เดิมซ้ำ (เช่น คำตอบหายระหว่างทาง) → เซิร์ฟเวอร์ตอบ duplicate และไม่นับซ้ำ
            st.mark(a["id"], "pending")
            up.send_once()
            self.assertEqual(len([x for x in fake.seen if x == a["id"]]), 1)
            self.assertEqual(st.counts(), {"ok": 3, "error": 1})
            self.assertEqual(b["id"] in fake.seen, False)
            # ไม่มีอะไรค้าง → heartbeat (events ว่าง) ตามรอบ
            up._last_send = 0
            n_batches = len(fake.batches)
            up.send_once()
            self.assertEqual(fake.batches[-1]["events"], [])
            self.assertEqual(len(fake.batches), n_batches + 1)
            self.assertIn("version", fake.batches[-1]["gateway"])

    def test_bad_key(self):
        fake = FakeAgroLink()
        with tempfile.TemporaryDirectory() as d:
            st = Store(os.path.join(d, "gw.db"))
            up = Uplink(make_cfg(d, fake.url), st, lambda: "dk_" + "b" * 48)
            st.enqueue("reading", channel="tank1", temp_c=4)
            with self.assertRaises(PermissionError):
                up.send_once()
            self.assertEqual(st.counts(), {"pending": 1})


class EndToEndTest(unittest.TestCase):
    """ตัวจำลองอุปกรณ์ → Gateway (หน้าจอ + คิว) → AgroLink จำลอง"""

    def test_staff_flow(self):
        from agrolink_gw.app import Gateway
        from agrolink_gw.web import serve

        fake = FakeAgroLink()
        ports = [free_port() for _ in range(3)]
        servers = sim.start(*ports, analyzer_every_s=1.5)
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "device.key"), "w") as f:
                f.write(KEY)
            ser = {"baud": 9600}
            cfg = make_cfg(d, fake.url, gateway={"data_dir": d, "ui_port": 0, "ui_pin": "2468", "ui_host": "127.0.0.1"},
                           scale=[{"channel": "scale1", "port": f"socket://127.0.0.1:{ports[0]}", **ser}],
                           analyzer=[{"channel": "analyzer1", "port": f"socket://127.0.0.1:{ports[1]}", **ser, "format": "csv",
                                      "fields": ["sample_no", "fat_pct", "snf_pct", "density", "protein_pct", "lactose_pct", "added_water_pct", "milk_temp_c", "freezing_point_c"]}],
                           modbus=[{"port": f"socket://127.0.0.1:{ports[2]}", **ser, "interval_s": 0.5, "send_every_s": 0.5, "sensor": [
                               {"channel": "tank1", "field": "temp_c", "function": 4, "register": 1, "scale": 0.1}]}])
            gw = Gateway(cfg)
            gw.start()
            srv = serve(gw)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{srv.server_address[1]}"
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

            def call(path, body=None):
                req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                             headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
                try:
                    with opener.open(req, timeout=5) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, json.loads(e.read())

            try:
                self.assertEqual(call("/api/state")[0], 401)  # ต้องใส่ PIN
                self.assertEqual(call("/api/login", {"pin": "0000"})[0], 401)
                self.assertEqual(call("/api/login", {"pin": "2468"})[0], 200)
                wait_for(lambda: gw.store.member_count() == 2)
                self.assertEqual(call("/api/capture", {})[1]["error"], "no_member")
                self.assertEqual(call("/api/member", {"code": "NOPE"})[1]["error"], "unknown_member")
                self.assertEqual(call("/api/member", {"code": "A001"})[1]["member"]["name"], "สมชาย")
                # รอจนน้ำหนักนิ่งแล้วบันทึก
                ev = wait_for(lambda: (lambda r: r if "weight_kg" in r else None)(call("/api/capture", {})[1]), timeout=15, step=0.2)
                self.assertTrue(ev and 18 <= ev["weight_kg"] <= 42, ev)
                self.assertEqual(call("/api/capture", {})[1]["error"], "already_recorded")  # ถังเดิม ต้องยกออกก่อน
                # รอส่งขึ้นระบบ + ผลวิเคราะห์ผูกกับสมาชิกที่เลือก + ค่าถังเย็น
                self.assertTrue(wait_for(lambda: ev["id"] in fake.seen, timeout=10))
                sent = [e for b in fake.batches for e in b["events"]]
                self.assertTrue(wait_for(lambda: any(e["type"] == "analysis" for b in fake.batches for e in b["events"]), timeout=10))
                self.assertTrue(wait_for(lambda: any(e["type"] == "reading" for b in fake.batches for e in b["events"]), timeout=10))
                sent = [e for b in fake.batches for e in b["events"]]
                an = next(e for e in sent if e["type"] == "analysis")
                self.assertEqual(an["member_code"], "A001")
                self.assertIn("fat_pct", an)
                intake = next(e for e in sent if e["type"] == "intake")
                self.assertEqual(intake["member_code"], "A001")
                self.assertTrue(intake["at"].endswith("Z"))
                st = call("/api/state")[1]
                self.assertTrue(st["uplink"]["online"])
                self.assertEqual(st["member"]["code"], "A001")
                self.assertGreater(st["member"]["today_kg"], 0)
                self.assertEqual(call("/api/member", {"code": ""})[1]["member"], None)
            finally:
                gw.stop()
                srv.shutdown()
                for s in servers:
                    s.shutdown()


if __name__ == "__main__":
    unittest.main()
