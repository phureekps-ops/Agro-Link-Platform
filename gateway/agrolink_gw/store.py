"""ที่เก็บข้อมูลในเครื่อง (SQLite): คิวส่งข้อมูล (outbox), รายชื่อสมาชิก/ช่องที่ดึงจาก AgroLink, ค่าต่าง ๆ

ทุกเหตุการณ์ถูกเขียนลงดิสก์ก่อน แล้วจึงส่ง — ไฟดับ/เน็ตหลุดก็ไม่หาย และส่งซ้ำได้อย่างปลอดภัยเพราะ
มีรหัสเหตุการณ์ (id) ที่เซิร์ฟเวอร์ใช้กันบันทึกซ้ำ
"""
import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, channel TEXT, at TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
  created REAL NOT NULL, sent REAL
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (status, created);
CREATE TABLE IF NOT EXISTS members (code TEXT PRIMARY KEY, name TEXT NOT NULL, withdrawal INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex}"


class Store:
    def __init__(self, path):
        d = os.path.dirname(os.path.abspath(path))
        os.makedirs(d, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")  # ไฟดับก็ไม่เสียรายการที่ยืนยันแล้ว
        self.db.executescript(SCHEMA)

    # ---- outbox -------------------------------------------------------
    def enqueue(self, etype, channel=None, at=None, **fields):
        ev = {"id": new_id(etype[:3]), "type": etype, "at": at or now_iso(), **fields}
        if channel:
            ev["channel"] = channel
        with self.lock:
            self.db.execute("INSERT INTO outbox (id, type, channel, at, body, created) VALUES (?,?,?,?,?,?)",
                            (ev["id"], etype, channel, ev["at"], json.dumps(ev, ensure_ascii=False), time.time()))
        return ev

    def pending(self, limit=100):
        with self.lock:
            rows = self.db.execute("SELECT body FROM outbox WHERE status='pending' ORDER BY created LIMIT ?", (limit,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def mark(self, event_id, status, error=None, result=None):
        with self.lock:
            self.db.execute(
                "UPDATE outbox SET status=?, error=?, result=?, sent=?, attempts=attempts+1 WHERE id=?",
                (status, error, json.dumps(result, ensure_ascii=False) if result is not None else None, time.time(), event_id))

    def bump_attempt(self, ids):
        with self.lock:
            self.db.executemany("UPDATE outbox SET attempts=attempts+1 WHERE id=?", [(i,) for i in ids])

    def counts(self):
        with self.lock:
            rows = self.db.execute("SELECT status, COUNT(*) FROM outbox GROUP BY status").fetchall()
        return {k: v for k, v in rows}

    def recent(self, etype=None, limit=30):
        q = "SELECT body, status, error, result FROM outbox"
        args = []
        if etype:
            q += " WHERE type=?"
            args.append(etype)
        q += " ORDER BY created DESC LIMIT ?"
        args.append(limit)
        with self.lock:
            rows = self.db.execute(q, args).fetchall()
        out = []
        for body, status, error, result in rows:
            ev = json.loads(body)
            ev["_status"] = status
            ev["_error"] = error
            ev["_result"] = json.loads(result) if result else None
            out.append(ev)
        return out

    def prune(self, keep_days=30):
        """ลบรายการที่ส่งสำเร็จแล้วเก่ากว่า keep_days (รายการที่ยังไม่ส่งไม่ถูกลบ)"""
        with self.lock:
            self.db.execute("DELETE FROM outbox WHERE status IN ('ok','duplicate') AND sent < ?", (time.time() - keep_days * 86400,))

    # ---- members / kv --------------------------------------------------
    def set_members(self, members):
        with self.lock:
            self.db.execute("BEGIN")
            self.db.execute("DELETE FROM members")
            self.db.executemany("INSERT INTO members (code, name, withdrawal) VALUES (?,?,?)",
                                [(m["member_code"], m["full_name"], 1 if m.get("withdrawal") else 0) for m in members])
            self.db.execute("COMMIT")

    def member(self, code):
        with self.lock:
            r = self.db.execute("SELECT code, name, withdrawal FROM members WHERE code=?", (code,)).fetchone()
        return {"code": r[0], "name": r[1], "withdrawal": bool(r[2])} if r else None

    def search_members(self, q, limit=20):
        like = f"%{q}%"
        with self.lock:
            rows = self.db.execute("SELECT code, name, withdrawal FROM members WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT ?",
                                   (like, like, limit)).fetchall()
        return [{"code": a, "name": b, "withdrawal": bool(c)} for a, b, c in rows]

    def member_count(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM members").fetchone()[0]

    def set(self, k, v):
        with self.lock:
            self.db.execute("INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v, ensure_ascii=False)))

    def get(self, k, default=None):
        with self.lock:
            r = self.db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default
