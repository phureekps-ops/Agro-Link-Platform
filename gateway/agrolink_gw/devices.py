"""ตัวอ่านอุปกรณ์ที่ศูนย์รับนม: เครื่องชั่ง (Serial), เครื่องวิเคราะห์นม (Serial), เซนเซอร์ถัง (Modbus RTU)

port รับได้ทั้ง /dev/ttyS1, /dev/ttyUSB0, COM3 และ URL ของ pyserial เช่น socket://127.0.0.1:7001
(ใช้กับตัวจำลองอุปกรณ์ หรือตัวแปลง Serial-to-Ethernet)
"""
import logging
import re
import struct
import threading
import time

log = logging.getLogger("agrolink_gw.devices")


def open_port(c, timeout=1.0):
    import serial  # pyserial

    return serial.serial_for_url(c["port"], baudrate=c["baud"], bytesize=c["bytesize"], parity=c["parity"],
                                 stopbits=c["stopbits"], timeout=timeout)


class PortThread(threading.Thread):
    """อ่านทีละบรรทัดจากพอร์ต Serial และเชื่อมต่อใหม่เองเมื่อสายหลุด"""

    def __init__(self, c, name):
        super().__init__(daemon=True, name=name)
        self.c = c
        self.stop_ev = threading.Event()
        self.connected = False
        self.last_error = None
        self.last_line_at = None

    def stop(self):
        self.stop_ev.set()

    def on_line(self, line):  # pragma: no cover - overridden
        raise NotImplementedError

    def poll(self, port):
        """เรียกก่อนอ่านแต่ละรอบ (เช่น ส่งคำสั่งขอน้ำหนัก)"""

    def run(self):
        buf = b""
        while not self.stop_ev.is_set():
            try:
                with open_port(self.c, timeout=0.3) as port:
                    self.connected, self.last_error = True, None
                    log.info("%s: connected %s", self.name, self.c["port"])
                    while not self.stop_ev.is_set():
                        self.poll(port)
                        chunk = port.read(256)
                        if not chunk:
                            continue
                        buf += chunk
                        while True:
                            m = re.search(rb"\r\n|\n|\r", buf)
                            if not m:
                                break
                            raw, buf = buf[: m.start()], buf[m.end():]
                            line = raw.decode(self.c["encoding"], errors="replace").strip()
                            if line:
                                self.last_line_at = time.time()
                                try:
                                    self.on_line(line)
                                except Exception:  # noqa: BLE001 - one bad line must not kill the reader
                                    log.exception("%s: cannot handle line %r", self.name, line)
                        if len(buf) > 4096:
                            buf = b""
            except Exception as e:  # noqa: BLE001
                self.connected, self.last_error = False, str(e)
                log.warning("%s: %s — retry in 3 s", self.name, e)
                self.stop_ev.wait(3)


# ---------------------------------------------------------------------------
# เครื่องชั่ง
# ---------------------------------------------------------------------------
class ScaleParser:
    """แปลงข้อความจากเครื่องชั่งเป็น (น้ำหนัก, นิ่งหรือยัง). ถ้ารูปแบบไม่มีกลุ่ม stable ใช้ค่าซ้ำ N ครั้งตัดสินแทน"""

    def __init__(self, pattern, window=3, tolerance=0.05):
        self.re = re.compile(pattern)
        self.window = max(2, window)
        self.tol = tolerance
        self.hist = []

    def feed(self, line):
        m = self.re.search(line)
        if not m:
            return None
        w = float(m.group("weight"))
        self.hist = (self.hist + [w])[-self.window:]
        if "stable" in self.re.groupindex and m.group("stable") is not None:
            st = m.group("stable").upper() in ("ST", "S", "STABLE", "1")
        else:
            st = len(self.hist) == self.window and max(self.hist) - min(self.hist) <= self.tol
        return w, st


class Scale(PortThread):
    def __init__(self, c):
        super().__init__(c, f"scale:{c['channel']}")
        self.parser = ScaleParser(c["pattern"], c["stable_window"], c["stable_tolerance_kg"])
        self.weight = None
        self.stable = False
        self.updated = None
        self.armed = True  # ต้องยกถังออก (น้ำหนักต่ำกว่า min_kg) ก่อนบันทึกถังถัดไป — กันบันทึกซ้ำถังเดิม
        self._last_req = 0.0
        self.lock = threading.Lock()

    def poll(self, port):
        req = self.c.get("request")
        if req and time.time() - self._last_req >= self.c["request_every_s"]:
            port.write(req.encode("latin-1"))  # TOML "Q\r\n" แปลงเป็นอักขระจริงแล้ว
            self._last_req = time.time()

    def on_line(self, line):
        r = self.parser.feed(line)
        if r is None:
            return
        with self.lock:
            self.weight, self.stable = r
            self.updated = time.time()
            if self.weight < self.c["min_kg"]:
                self.armed = True

    def snapshot(self):
        with self.lock:
            fresh = self.updated is not None and time.time() - self.updated < 3
            return {
                "channel": self.c["channel"], "label": self.c["label"], "connected": self.connected and fresh,
                "weight": self.weight if fresh else None, "stable": bool(self.stable and fresh), "armed": self.armed,
                "ready": bool(fresh and self.stable and self.armed and self.weight is not None and self.weight >= self.c["min_kg"]),
                "error": self.last_error,
            }

    def take(self):
        """คืนน้ำหนักที่บันทึกได้ (นิ่ง ≥ min_kg และยังไม่ถูกบันทึก) หรือเหตุผลที่บันทึกไม่ได้"""
        with self.lock:
            fresh = self.updated is not None and time.time() - self.updated < 3
            if not fresh:
                return None, "scale_offline"
            if not self.stable:
                return None, "not_stable"
            if self.weight < self.c["min_kg"]:
                return None, "below_min"
            if not self.armed:
                return None, "already_recorded"
            self.armed = False
            return round(self.weight, 2), None


# ---------------------------------------------------------------------------
# เครื่องวิเคราะห์น้ำนม
# ---------------------------------------------------------------------------
ANALYSIS_KEYS = ("sample_no", "member_code", "fat_pct", "snf_pct", "protein_pct", "lactose_pct", "density",
                 "added_water_pct", "freezing_point_c", "milk_temp_c")
_NUM = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _to_num(v):
    m = _NUM.search(str(v))
    return float(m.group(0).replace(",", ".")) if m else None


def parse_analysis(line, c):
    """แปลงหนึ่งบรรทัด/หนึ่งระเบียนผลวิเคราะห์ → dict (ไม่ตรงรูปแบบ = None). รองรับ 3 แบบ:
    csv: แยกด้วย delimiter ตามลำดับ fields ("" หรือ "-" = ข้ามคอลัมน์)
    regex: named groups ชื่อเดียวกับ ANALYSIS_KEYS
    keyvalue: "Fat=3.85 SNF=8.40 ..." โดย keys = {"Fat": "fat_pct", ...}
    """
    for p in c.get("skip_prefix", []):
        if line.startswith(p):
            return None
    out = {}
    fmt = c["format"]
    if fmt == "csv":
        cols = [x.strip() for x in line.split(c["delimiter"])]
        if len(cols) < len([f for f in c["fields"] if f and f != "-"]):
            return None
        for f, v in zip(c["fields"], cols):
            if f and f != "-" and f in ANALYSIS_KEYS:
                out[f] = v
    elif fmt == "regex":
        m = re.search(c["pattern"], line)
        if not m:
            return None
        out = {k: v for k, v in m.groupdict().items() if k in ANALYSIS_KEYS and v is not None}
    else:
        for k, v in re.findall(r"([A-Za-z_][\w ]*?)\s*[=:]\s*([-+]?\d+(?:[.,]\d+)?)", line):
            key = c["keys"].get(k.strip())
            if key in ANALYSIS_KEYS:
                out[key] = v
    res = {}
    for k, v in out.items():
        if k in ("sample_no", "member_code"):
            v = str(v).strip()
            if v:
                res[k] = v[:40]
        else:
            x = _to_num(v)
            if x is not None:
                res[k] = x
    if not any(k in res for k in ("fat_pct", "snf_pct", "protein_pct", "density")):
        return None
    return res


class Analyzer(PortThread):
    def __init__(self, c, on_result):
        super().__init__(c, f"analyzer:{c['channel']}")
        self.on_result = on_result
        self.last = None

    def on_line(self, line):
        r = parse_analysis(line, self.c)
        if r is None:
            log.debug("%s: skip %r", self.name, line)
            return
        self.last = {**r, "_at": time.time()}
        self.on_result(self.c, r)

    def snapshot(self):
        fresh = self.last_line_at is not None and time.time() - self.last_line_at < 86400
        return {"channel": self.c["channel"], "label": self.c["label"], "connected": self.connected, "last": self.last if fresh else None,
                "error": self.last_error}


# ---------------------------------------------------------------------------
# Modbus RTU (อุณหภูมิถัง / ระดับนมในถัง)
# ---------------------------------------------------------------------------
def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return struct.pack("<H", crc)


def rtu_request(slave, function, register, count):
    pdu = struct.pack(">BBHH", slave, function, register, count)
    return pdu + crc16(pdu)


class ModbusError(IOError):
    pass


def rtu_parse(resp, slave, function, count):
    if len(resp) < 5:
        raise ModbusError("no_response")
    if crc16(resp[:-2]) != resp[-2:]:
        raise ModbusError("bad_crc")
    if resp[0] != slave:
        raise ModbusError("wrong_slave")
    if resp[1] == function | 0x80:
        raise ModbusError(f"exception_{resp[2]}")
    if resp[1] != function or resp[2] != count * 2 or len(resp) != 5 + count * 2:
        raise ModbusError("bad_frame")
    return resp[3:3 + count * 2]


def decode(raw, typ, word_order="big"):
    if typ in ("int32", "uint32", "float32") and word_order == "little":
        raw = raw[2:4] + raw[0:2]
    fmt = {"int16": ">h", "uint16": ">H", "int32": ">i", "uint32": ">I", "float32": ">f"}[typ]
    return struct.unpack(fmt, raw)[0]


REG_COUNT = {"int16": 1, "uint16": 1, "int32": 2, "uint32": 2, "float32": 2}


class ModbusBus(threading.Thread):
    """อ่านเซนเซอร์ทุก interval_s แล้วส่งค่าล่าสุดต่อช่องทุก send_every_s (ลดปริมาณข้อมูล)"""

    def __init__(self, c, on_reading):
        super().__init__(daemon=True, name=f"modbus:{c['port']}")
        self.c = c
        self.on_reading = on_reading
        self.stop_ev = threading.Event()
        self.values = {}  # channel -> {field: (value, ts)}
        self.errors = {}
        self.connected = False
        self._last_sent = {}

    def stop(self):
        self.stop_ev.set()

    def read_sensor(self, port, s):
        count = REG_COUNT[s["type"]]
        port.reset_input_buffer()
        port.write(rtu_request(s["slave"], s["function"], s["register"], count))
        need = 5 + count * 2
        resp = b""
        deadline = time.time() + self.c["timeout_s"]
        while len(resp) < need and time.time() < deadline:
            chunk = port.read(need - len(resp))
            if chunk:
                resp += chunk
                if len(resp) >= 2 and resp[1] & 0x80 and len(resp) >= 5:
                    break
        data = rtu_parse(resp, s["slave"], s["function"], count)
        return round(decode(data, s["type"], s["word_order"]) * s["scale"] + s["offset"], 3)

    def run(self):
        while not self.stop_ev.is_set():
            try:
                with open_port(self.c, timeout=0.2) as port:
                    self.connected = True
                    while not self.stop_ev.is_set():
                        for s in self.c["sensors"]:
                            key = f"{s['channel']}.{s['field']}"
                            try:
                                v = self.read_sensor(port, s)
                                self.values.setdefault(s["channel"], {})[s["field"]] = (v, time.time())
                                self.errors.pop(key, None)
                            except (ModbusError, OSError) as e:
                                self.errors[key] = str(e)
                            time.sleep(0.05)  # ช่องว่างระหว่างเฟรม RTU
                        self.flush()
                        self.stop_ev.wait(self.c["interval_s"])
            except Exception as e:  # noqa: BLE001
                self.connected = False
                log.warning("modbus %s: %s — retry in 5 s", self.c["port"], e)
                self.stop_ev.wait(5)

    def flush(self, force=False):
        now = time.time()
        for ch, fields in self.values.items():
            if not force and now - self._last_sent.get(ch, 0) < self.c["send_every_s"]:
                continue
            fresh = {f: v for f, (v, ts) in fields.items() if now - ts < max(3 * self.c["interval_s"], 30)}
            if fresh:
                self.on_reading(ch, fresh)
                self._last_sent[ch] = now

    def snapshot(self):
        now = time.time()
        return {
            "port": self.c["port"], "connected": self.connected, "errors": dict(self.errors),
            "values": {ch: {f: {"value": v, "age_s": round(now - ts)} for f, (v, ts) in fs.items()} for ch, fs in self.values.items()},
        }
