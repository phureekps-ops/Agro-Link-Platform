"""อ่านไฟล์ตั้งค่า (TOML) ของ Gateway — ดูตัวอย่างใน gateway/config.example.toml"""
import os

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - Python 3.9/3.10 on older gateways
    import tomli as tomllib  # type: ignore

DEFAULT_API = "https://agrolink-backend-vhv6.onrender.com"
CHANNEL_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_-")

# รูปแบบข้อความเครื่องชั่งที่พบบ่อย: "ST,GS,+0012.34kg" (ST = นิ่ง, US = ยังแกว่ง)
DEFAULT_SCALE_PATTERN = r"^(?P<stable>ST|US),(?:GS|NT),\s*(?P<weight>[+-]?\d+(?:\.\d+)?)\s*kg"


class ConfigError(ValueError):
    pass


def _channel(v, where):
    v = str(v or "")
    if not (1 <= len(v) <= 32) or not set(v) <= CHANNEL_CHARS:
        raise ConfigError(f"{where}: channel ต้องเป็น a-z 0-9 _ - ไม่เกิน 32 ตัว (ได้ {v!r})")
    return v


def _serial(d, where):
    if not d.get("port"):
        raise ConfigError(f"{where}: ต้องระบุ port เช่น /dev/ttyS1 หรือ /dev/ttyUSB0")
    return {
        "port": str(d["port"]),
        "baud": int(d.get("baud", 9600)),
        "bytesize": int(d.get("bytesize", 8)),
        "parity": str(d.get("parity", "N")).upper(),
        "stopbits": float(d.get("stopbits", 1)),
        "encoding": str(d.get("encoding", "ascii")),
    }


def load(path):
    with open(path, "rb") as f:
        raw = tomllib.load(f)
    return parse(raw, base_dir=os.path.dirname(os.path.abspath(path)))


def parse(raw, base_dir="."):
    ag = raw.get("agrolink", {})
    gw = raw.get("gateway", {})
    data_dir = gw.get("data_dir", "/var/lib/agrolink-gw")
    cfg = {
        "api_base": str(ag.get("api_base", DEFAULT_API)).rstrip("/"),
        "key_file": ag.get("key_file") or os.path.join(data_dir, "device.key"),
        "timeout_s": float(ag.get("timeout_s", 20)),
        "send_every_s": float(ag.get("send_every_s", 3)),
        "heartbeat_s": float(ag.get("heartbeat_s", 60)),
        "config_sync_s": float(ag.get("config_sync_s", 600)),
        "data_dir": data_dir,
        "ui_host": str(gw.get("ui_host", "0.0.0.0")),
        "ui_port": int(gw.get("ui_port", 8080)),
        "ui_pin": str(gw.get("ui_pin", "")),
        "name": str(gw.get("name", "agrolink-gateway")),
        "scales": [],
        "analyzers": [],
        "modbus": [],
    }
    if not cfg["api_base"].startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise ConfigError("agrolink.api_base ต้องเป็น https:// (ยกเว้น localhost สำหรับทดสอบ)")
    seen = set()

    def uniq(ch, where):
        if ch in seen:
            raise ConfigError(f"{where}: channel {ch!r} ซ้ำ")
        seen.add(ch)

    for i, s in enumerate(raw.get("scale", [])):
        where = f"scale[{i}]"
        ch = _channel(s.get("channel"), where)
        uniq(ch, where)
        cfg["scales"].append({
            "channel": ch, "label": str(s.get("label", ch)), **_serial(s, where),
            "pattern": str(s.get("pattern", DEFAULT_SCALE_PATTERN)),
            "min_kg": float(s.get("min_kg", 0.5)),
            "stable_window": int(s.get("stable_window", 3)),
            "stable_tolerance_kg": float(s.get("stable_tolerance_kg", 0.05)),
            "request": s.get("request"),  # คำสั่งขอน้ำหนัก (ถ้าเครื่องชั่งไม่ส่งเอง) เช่น "Q\r\n"
            "request_every_s": float(s.get("request_every_s", 0.5)),
        })
    for i, a in enumerate(raw.get("analyzer", [])):
        where = f"analyzer[{i}]"
        ch = _channel(a.get("channel"), where)
        uniq(ch, where)
        fmt = str(a.get("format", "csv"))
        if fmt not in ("csv", "regex", "keyvalue"):
            raise ConfigError(f"{where}: format ต้องเป็น csv, regex หรือ keyvalue")
        cfg["analyzers"].append({
            "channel": ch, "label": str(a.get("label", ch)), **_serial(a, where), "format": fmt,
            "delimiter": str(a.get("delimiter", ",")),
            "fields": list(a.get("fields", [])),
            "pattern": a.get("pattern"),
            "keys": dict(a.get("keys", {})),
            "skip_prefix": list(a.get("skip_prefix", [])),
            "attach_member_s": float(a.get("attach_member_s", 600)),
        })
        if fmt == "csv" and not cfg["analyzers"][-1]["fields"]:
            raise ConfigError(f"{where}: format csv ต้องมี fields (ลำดับคอลัมน์)")
        if fmt == "regex" and not a.get("pattern"):
            raise ConfigError(f"{where}: format regex ต้องมี pattern")
        if fmt == "keyvalue" and not a.get("keys"):
            raise ConfigError(f"{where}: format keyvalue ต้องมี keys")
    for i, m in enumerate(raw.get("modbus", [])):
        where = f"modbus[{i}]"
        bus = {**_serial(m, where), "interval_s": float(m.get("interval_s", 30)), "send_every_s": float(m.get("send_every_s", 60)),
               "timeout_s": float(m.get("timeout_s", 1.0)), "sensors": []}
        for j, sn in enumerate(m.get("sensor", [])):
            w = f"{where}.sensor[{j}]"
            field = sn.get("field")
            if field not in ("temp_c", "level_kg"):
                raise ConfigError(f"{w}: field ต้องเป็น temp_c หรือ level_kg")
            typ = str(sn.get("type", "int16"))
            if typ not in ("int16", "uint16", "int32", "uint32", "float32"):
                raise ConfigError(f"{w}: type ไม่รองรับ {typ}")
            fn = int(sn.get("function", 3))
            if fn not in (3, 4):
                raise ConfigError(f"{w}: function ต้องเป็น 3 (holding) หรือ 4 (input)")
            bus["sensors"].append({
                "channel": _channel(sn.get("channel"), w), "field": field, "slave": int(sn.get("slave", 1)), "function": fn,
                "register": int(sn.get("register", 0)), "type": typ, "scale": float(sn.get("scale", 1)), "offset": float(sn.get("offset", 0)),
                "word_order": str(sn.get("word_order", "big")),
            })
        cfg["modbus"].append(bus)
    return cfg


def read_key(cfg):
    try:
        with open(cfg["key_file"], encoding="ascii") as f:
            key = f.read().strip()
    except FileNotFoundError:
        return None
    return key or None
