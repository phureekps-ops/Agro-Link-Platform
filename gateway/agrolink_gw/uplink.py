"""ส่งข้อมูลขึ้น AgroLink: คิวในเครื่อง → POST /dairy-iot/gateway/events เป็นชุด, ดึงรายชื่อสมาชิก/ช่องทุก 10 นาที

ผลต่อเหตุการณ์จากเซิร์ฟเวอร์:
  ok / duplicate → ส่งสำเร็จ (ลบออกจากคิว)
  error          → ผิดถาวร (เช่น ไม่พบรหัสสมาชิก) เก็บไว้ให้เจ้าหน้าที่เห็นในหน้าจอ ไม่ส่งซ้ำ
  retry          → ระบบขัดข้องชั่วคราว ส่งใหม่รอบหน้า
เน็ตหลุด/เซิร์ฟเวอร์ล่ม → รอแบบทวีคูณ (สูงสุด 60 วินาที) แล้วลองใหม่ ข้อมูลยังอยู่ในคิว
"""
import json
import logging
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

from . import __version__

log = logging.getLogger("agrolink_gw.uplink")


class Uplink(threading.Thread):
    def __init__(self, cfg, store, key_provider, info_provider=lambda: {}):
        super().__init__(daemon=True, name="uplink")
        self.cfg = cfg
        self.store = store
        self.key_provider = key_provider
        self.info_provider = info_provider
        self.stop_ev = threading.Event()
        self.wake = threading.Event()
        self.online = False
        self.last_ok = None
        self.last_error = None
        self.clock_skew_s = None
        self.started = time.time()
        self._backoff = 0
        self._last_send = 0.0
        self._last_sync = 0.0
        self._last_prune = 0.0
        self.ctx = ssl.create_default_context()

    def stop(self):
        self.stop_ev.set()
        self.wake.set()

    def _request(self, method, path, body=None):
        key = self.key_provider()
        if not key:
            raise PermissionError("no_device_key")
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.cfg["api_base"] + path, data=data, method=method, headers={
            "X-Device-Key": key, "Content-Type": "application/json", "User-Agent": f"agrolink-gw/{__version__}",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.cfg["timeout_s"], context=self.ctx if self.cfg["api_base"].startswith("https") else None) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8") or "{}")
            except ValueError:
                payload = {}
            return e.code, payload

    def _note_clock(self, server_time):
        try:
            st = datetime.fromisoformat(server_time.replace("Z", "+00:00")).timestamp()
            self.clock_skew_s = round(time.time() - st, 1)
        except (ValueError, AttributeError):
            pass

    def sync_config(self):
        status, body = self._request("GET", "/dairy-iot/gateway/config")
        if status != 200:
            raise IOError(f"config_http_{status}:{body.get('error')}")
        self.store.set_members(body.get("members", []))
        self.store.set("remote_config", {k: body.get(k) for k in ("gateway", "coop", "center", "channels")})
        self.store.set("config_synced_at", time.time())
        self._note_clock(body.get("server_time"))
        self._last_sync = time.time()
        return body

    def send_once(self, limit=100):
        """ส่งหนึ่งชุด คืนจำนวนเหตุการณ์ที่ส่ง (0 = ไม่มีอะไรค้าง → ส่ง heartbeat ถ้าถึงเวลา)"""
        events = self.store.pending(limit)
        heartbeat_due = time.time() - self._last_send >= self.cfg["heartbeat_s"]
        if not events and not heartbeat_due:
            return 0
        counts = self.store.counts()
        info = {"version": __version__, "queue": max(0, counts.get("pending", 0) - len(events)),  # ที่ยังค้างหลังชุดนี้
                 "uptime_s": int(time.time() - self.started), **self.info_provider()}
        status, body = self._request("POST", "/dairy-iot/gateway/events", {"gateway": info, "events": events})
        if status in (401, 403):
            raise PermissionError(f"key_rejected:{body.get('error')}")
        if status != 200:
            raise IOError(f"http_{status}:{body.get('error')}")
        self._note_clock(body.get("server_time"))
        by_id = {r.get("id"): r for r in body.get("results", [])}
        retry = []
        for ev in events:
            r = by_id.get(ev["id"])
            if not r or r.get("status") == "retry":
                retry.append(ev["id"])
            elif r["status"] == "ok":
                self.store.mark(ev["id"], "ok", result=r.get("data"))
            elif r["status"] == "duplicate":
                self.store.mark(ev["id"], "ok" if r.get("ok", True) else "error", error=r.get("error"), result=r.get("data"))
            else:
                self.store.mark(ev["id"], "error", error=r.get("error"), result=r.get("data"))
                log.warning("event %s rejected: %s", ev["id"], r.get("error"))
        if retry:
            self.store.bump_attempt(retry)
        self._last_send = time.time()
        return len(events)

    def run(self):
        while not self.stop_ev.is_set():
            try:
                if time.time() - self._last_sync >= self.cfg["config_sync_s"]:
                    self.sync_config()
                n = self.send_once()
                self.online, self.last_ok, self.last_error, self._backoff = True, time.time(), None, 0
                if n >= 100:
                    continue  # ยังค้างอีก ส่งต่อทันที
                self.wake.wait(self.cfg["send_every_s"])
                self.wake.clear()
            except Exception as e:  # noqa: BLE001 - network/server errors: keep everything queued and back off
                self.online = False
                self.last_error = str(e)
                self._backoff = min(60, max(2, self._backoff * 2 or 2))
                log.warning("uplink: %s — retry in %ss", e, self._backoff)
                self.stop_ev.wait(self._backoff)
            if time.time() - self._last_prune > 3600:
                self.store.prune()
                self._last_prune = time.time()

    def status(self):
        return {
            "online": self.online, "last_ok": self.last_ok, "last_error": self.last_error, "clock_skew_s": self.clock_skew_s,
            "queue": self.store.counts(), "config_synced_at": self.store.get("config_synced_at"),
        }
