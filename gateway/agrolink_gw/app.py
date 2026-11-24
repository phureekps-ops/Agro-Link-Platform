"""หัวใจของ Gateway: ต่ออุปกรณ์ทุกตัว + คิว + ส่งขึ้น AgroLink + สถานะสำหรับหน้าจอเจ้าหน้าที่"""
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from . import __version__
from .config import read_key
from .devices import Analyzer, ModbusBus, Scale
from .store import Store
from .uplink import Uplink

log = logging.getLogger("agrolink_gw")

def bkk_day(iso):
    """วันที่ตามเวลาไทยของ timestamp ISO (รอบรับนมนับตามวันไทย)"""
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (t.astimezone(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")


ERR_TH = {
    "no_member": "ยังไม่ได้เลือกสมาชิก", "unknown_member": "ไม่พบรหัสสมาชิกนี้ในศูนย์", "unknown_scale": "ไม่พบเครื่องชั่งช่องนี้",
    "scale_offline": "เครื่องชั่งไม่ส่งค่า (ตรวจสาย/เปิดเครื่อง)", "not_stable": "น้ำหนักยังไม่นิ่ง", "below_min": "น้ำหนักน้อยเกินไป",
    "already_recorded": "ถังนี้บันทึกแล้ว — ยกถังออกก่อนชั่งถังถัดไป",
}


class Gateway:
    def __init__(self, cfg):
        self.cfg = cfg
        self.store = Store(os.path.join(cfg["data_dir"], "gateway.db"))
        self.lock = threading.Lock()
        self.member = None  # สมาชิกที่กำลังรับนม (ใช้ผูกผลเครื่องวิเคราะห์ด้วย)
        self.member_at = 0.0
        self.scales = {s["channel"]: Scale(s) for s in cfg["scales"]}
        self.analyzers = [Analyzer(a, self._on_analysis) for a in cfg["analyzers"]]
        self.buses = [ModbusBus(m, self._on_reading) for m in cfg["modbus"]]
        self.uplink = Uplink(cfg, self.store, lambda: read_key(cfg), self._info)

    # ---- life cycle ----------------------------------------------------
    def start(self, uplink=True):
        for t in [*self.scales.values(), *self.analyzers, *self.buses]:
            t.start()
        if uplink:
            self.uplink.start()

    def stop(self):
        for t in [*self.scales.values(), *self.analyzers, *self.buses]:
            t.stop()
        self.uplink.stop()
        for b in self.buses:
            b.flush(force=True)

    def _info(self):
        ports = [{"channel": s.c["channel"], "connected": s.connected} for s in self.scales.values()]
        ports += [{"channel": a.c["channel"], "connected": a.connected} for a in self.analyzers]
        ports += [{"port": b.c["port"], "connected": b.connected} for b in self.buses]
        return {"ports": ports}

    # ---- events from devices --------------------------------------------
    def _on_reading(self, channel, values):
        self.store.enqueue("reading", channel=channel, **values)
        self.uplink.wake.set()

    def _on_analysis(self, c, r):
        ev = dict(r)
        if not ev.get("member_code"):
            with self.lock:
                if self.member and time.time() - self.member_at <= c["attach_member_s"]:
                    ev["member_code"] = self.member["code"]
        self.store.enqueue("analysis", channel=c["channel"], **ev)
        self.uplink.wake.set()

    # ---- actions from the staff screen -----------------------------------
    def select_member(self, code):
        code = str(code or "").strip()
        if not code:
            with self.lock:
                self.member = None
            return None, None
        m = self.store.member(code)
        if not m and self.store.member_count() > 0:
            return None, "unknown_member"
        if not m:  # ยังไม่เคยดึงรายชื่อ (เครื่องใหม่ + ยังไม่มีเน็ต) — ให้เซิร์ฟเวอร์ตรวจตอนส่ง
            m = {"code": code, "name": "(ยังไม่ได้ดึงรายชื่อ)", "withdrawal": False}
        with self.lock:
            self.member, self.member_at = m, time.time()
        return m, None

    def capture(self, channel=None):
        with self.lock:
            m = self.member
        if not m:
            return None, "no_member"
        sc = self.scales.get(channel) if channel else (next(iter(self.scales.values()), None))
        if not sc:
            return None, "unknown_scale"
        kg, err = sc.take()
        if err:
            return None, err
        ev = self.store.enqueue("intake", channel=sc.c["channel"], member_code=m["code"], weight_kg=kg)
        with self.lock:
            self.member_at = time.time()
        self.uplink.wake.set()
        return ev, None

    # ---- status for the screen -----------------------------------------
    def state(self):
        remote = self.store.get("remote_config", {}) or {}
        intakes = self.store.recent("intake", 40)
        analyses = self.store.recent("analysis", 20)
        with self.lock:
            m = dict(self.member) if self.member else None
        if m:
            today = bkk_day(datetime.now(timezone.utc).isoformat())
            m["today_kg"] = round(sum(e["weight_kg"] for e in intakes if e.get("member_code") == m["code"] and e.get("_status") != "error"
                                      and bkk_day(e["at"]) == today), 2)
        return {
            "version": __version__, "name": self.cfg["name"], "coop": remote.get("coop"), "center": (remote.get("center") or {}).get("name"),
            "member": m, "members_synced": self.store.member_count(),
            "scales": [s.snapshot() for s in self.scales.values()], "analyzers": [a.snapshot() for a in self.analyzers],
            "tanks": [b.snapshot() for b in self.buses], "uplink": self.uplink.status(),
            "intakes": [{k: e.get(k) for k in ("id", "at", "member_code", "weight_kg", "channel", "_status", "_error", "_result")} for e in intakes],
            "analyses": [{k: e.get(k) for k in ("id", "at", "member_code", "sample_no", "fat_pct", "snf_pct", "protein_pct", "added_water_pct", "_status", "_error", "_result")} for e in analyses],
            "has_key": bool(read_key(self.cfg)),
        }
