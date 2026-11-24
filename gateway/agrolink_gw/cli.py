"""คำสั่ง agrolink-gw

  agrolink-gw run          เริ่มทำงาน (ใช้โดย systemd / Docker)
  agrolink-gw setup        ใส่คีย์ Gateway จากพอร์ทัล (เก็บในไฟล์ สิทธิ์ 600) แล้วทดสอบการเชื่อมต่อ
  agrolink-gw check        ตรวจไฟล์ตั้งค่า + การเชื่อมต่อ AgroLink
  agrolink-gw test-scale   แสดงน้ำหนักจากเครื่องชั่ง 15 วินาที
  agrolink-gw test-analyzer แสดงผลจากเครื่องวิเคราะห์ 60 วินาที
  agrolink-gw test-modbus  อ่านเซนเซอร์ถังหนึ่งรอบ
  agrolink-gw status       สถานะคิว (รอส่ง/ส่งแล้ว/ไม่ผ่าน)
  agrolink-gw sim          เปิดตัวจำลองเครื่องชั่ง/เครื่องวิเคราะห์/Modbus (พอร์ต 7001-7003)
ไฟล์ตั้งค่า: --config หรือตัวแปร AGROLINK_GW_CONFIG (ค่าเริ่ม /etc/agrolink-gw/config.toml)
"""
import argparse
import getpass
import logging
import os
import re
import signal
import sys
import threading
import time

from . import __version__
from .config import ConfigError, load, read_key


def _cfg(args):
    path = args.config or os.environ.get("AGROLINK_GW_CONFIG", "/etc/agrolink-gw/config.toml")
    try:
        return load(path)
    except FileNotFoundError:
        sys.exit(f"ไม่พบไฟล์ตั้งค่า {path} — คัดลอกจาก config.example.toml แล้วแก้ไข")
    except (ConfigError, ValueError) as e:
        sys.exit(f"ไฟล์ตั้งค่าไม่ถูกต้อง: {e}")


def cmd_run(args):
    from .app import Gateway
    from .web import serve

    cfg = _cfg(args)
    gw = Gateway(cfg)
    if not read_key(cfg):
        logging.warning("ยังไม่มีคีย์ (%s) — รับข้อมูลเก็บไว้ในเครื่องได้ แต่จะยังไม่ส่ง: รัน agrolink-gw setup", cfg["key_file"])
    gw.start()
    srv = serve(gw)
    logging.info("AgroLink Gateway %s — หน้าจอรับนม http://%s:%s", __version__, cfg["ui_host"], cfg["ui_port"])

    def bye(*_):
        # shutdown() รอให้ serve_forever จบ — เรียกจากเธรดอื่น ไม่งั้นค้าง (signal handler อยู่ในเธรดเดียวกัน)
        logging.info("stopping…")
        gw.stop()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)
    srv.serve_forever()


def cmd_setup(args):
    cfg = _cfg(args)
    print("วางคีย์ Gateway ที่ได้จากพอร์ทัลสหกรณ์ (แท็บ IoT › เพิ่ม Gateway) — คีย์จะไม่แสดงบนจอ")
    key = (args.key or getpass.getpass("คีย์: ")).strip()
    if not re.fullmatch(r"dk_[0-9a-f]{48}", key):
        sys.exit("รูปแบบคีย์ไม่ถูกต้อง (ต้องขึ้นต้นด้วย dk_ ตามด้วยตัวอักษร 48 ตัว)")
    os.makedirs(os.path.dirname(os.path.abspath(cfg["key_file"])), exist_ok=True)
    fd = os.open(cfg["key_file"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key + "\n")
    print(f"บันทึกคีย์ที่ {cfg['key_file']} แล้ว")
    return cmd_check(args)


def cmd_check(args):
    from .store import Store
    from .uplink import Uplink

    cfg = _cfg(args)
    print(f"ไฟล์ตั้งค่าถูกต้อง: เครื่องชั่ง {len(cfg['scales'])} · เครื่องวิเคราะห์ {len(cfg['analyzers'])} · Modbus {len(cfg['modbus'])} สาย")
    up = Uplink(cfg, Store(os.path.join(cfg["data_dir"], "gateway.db")), lambda: read_key(cfg))
    try:
        body = up.sync_config()
    except PermissionError as e:
        sys.exit(f"เชื่อมต่อ AgroLink ไม่ได้: {e} — ตรวจคีย์ (agrolink-gw setup)")
    except Exception as e:  # noqa: BLE001
        sys.exit(f"เชื่อมต่อ AgroLink ไม่ได้: {e} — ตรวจอินเทอร์เน็ต/api_base")
    print(f"เชื่อมต่อแล้ว: {body.get('coop')} · {(body.get('center') or {}).get('name')} · สมาชิก {len(body.get('members', []))} ราย")
    mine = {c["channel"] for c in cfg["scales"] + cfg["analyzers"]} | {s["channel"] for b in cfg["modbus"] for s in b["sensors"]}
    remote = {c["channel"]: c for c in body.get("channels", [])}
    for ch in sorted(mine):
        print(f"  ช่อง {ch}: " + (f"ผูกแล้ว ({remote[ch]['name']})" if ch in remote else "ยังไม่ได้เพิ่มในพอร์ทัล — ข้อมูลช่องนี้จะถูกปฏิเสธ"))
    if up.clock_skew_s is not None and abs(up.clock_skew_s) > 120:
        print(f"⚠️ นาฬิกาเครื่องคลาด {up.clock_skew_s} วินาที — เปิด NTP ก่อนใช้งาน (รอบเช้า/เย็นใช้เวลาเครื่อง)")
    return 0


def cmd_test_scale(args):
    from .devices import Scale

    cfg = _cfg(args)
    if not cfg["scales"]:
        sys.exit("ไม่ได้ตั้งค่าเครื่องชั่ง")
    sc = Scale(cfg["scales"][0])
    sc.start()
    end = time.time() + args.seconds
    while time.time() < end:
        s = sc.snapshot()
        print(f"\r{s['weight'] if s['weight'] is not None else '--':>8} กก. {'นิ่ง' if s['stable'] else '...'} "
              f"{'' if s['connected'] else '(ไม่มีข้อมูล ' + str(s['error'] or 'ตรวจสาย/baud/pattern') + ')'}      ", end="", flush=True)
        time.sleep(0.3)
    print()
    sc.stop()


def cmd_test_analyzer(args):
    from .devices import Analyzer

    cfg = _cfg(args)
    if not cfg["analyzers"]:
        sys.exit("ไม่ได้ตั้งค่าเครื่องวิเคราะห์")
    a = Analyzer(cfg["analyzers"][0], lambda c, r: print("ผล:", r))
    orig = a.on_line
    a.on_line = lambda line: (print("รับ:", line), orig(line))
    a.start()
    print(f"รอผลจากเครื่องวิเคราะห์ {args.seconds} วินาที — สั่งวัดตัวอย่างที่เครื่อง")
    time.sleep(args.seconds)
    a.stop()


def cmd_test_modbus(args):
    from .devices import ModbusBus, open_port

    cfg = _cfg(args)
    for bus in cfg["modbus"]:
        b = ModbusBus(bus, lambda ch, v: None)
        with open_port(bus, timeout=0.2) as port:
            for s in bus["sensors"]:
                try:
                    print(f"{s['channel']}.{s['field']} = {b.read_sensor(port, s)}")
                except Exception as e:  # noqa: BLE001
                    print(f"{s['channel']}.{s['field']}: อ่านไม่ได้ ({e})")
                time.sleep(0.05)


def cmd_status(args):
    from .store import Store

    cfg = _cfg(args)
    st = Store(os.path.join(cfg["data_dir"], "gateway.db"))
    print("คิว:", st.counts())
    for e in st.recent(limit=10):
        print(f"  {e['at']} {e['type']:<8} {e.get('channel') or '':<10} {e['_status']:<8} {e.get('_error') or ''}")


def cmd_sim(args):
    from . import sim

    sim.start(analyzer_every_s=args.analyzer_every)
    print("ตัวจำลองพร้อม: เครื่องชั่ง socket://127.0.0.1:7001 · เครื่องวิเคราะห์ socket://127.0.0.1:7002 · Modbus socket://127.0.0.1:7003 (Ctrl+C เพื่อหยุด)")
    while True:
        time.sleep(3600)


def main(argv=None):
    p = argparse.ArgumentParser(prog="agrolink-gw", description="AgroLink Gateway สำหรับศูนย์รับนม")
    p.add_argument("--config", help="ไฟล์ตั้งค่า TOML")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sp = sub.add_parser("setup")
    sp.add_argument("--key", help=argparse.SUPPRESS)  # สำหรับสคริปต์ทดสอบเท่านั้น (คีย์จะอยู่ใน history)
    sub.add_parser("check")
    for name in ("test-scale", "test-analyzer"):
        sp = sub.add_parser(name)
        sp.add_argument("--seconds", type=int, default=15 if name == "test-scale" else 60)
    sub.add_parser("test-modbus")
    sub.add_parser("status")
    sp = sub.add_parser("sim")
    sp.add_argument("--analyzer-every", type=float, default=20.0)
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    fn = {"run": cmd_run, "setup": cmd_setup, "check": cmd_check, "test-scale": cmd_test_scale, "test-analyzer": cmd_test_analyzer,
          "test-modbus": cmd_test_modbus, "status": cmd_status, "sim": cmd_sim}[args.cmd]
    return fn(args)


if __name__ == "__main__":
    sys.exit(main())
