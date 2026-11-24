"""ตัวจำลองอุปกรณ์ (ใช้ทดสอบก่อนมีเครื่องจริง) — เปิดเป็นพอร์ต TCP ให้ Gateway ต่อด้วย port = "socket://127.0.0.1:<port>"

  เครื่องชั่ง      : ส่ง "ST,GS,+0012.34kg" ทุก 0.2 วินาที วนรอบ เท ↗ นิ่ง → ยกออก → 0
  เครื่องวิเคราะห์ : ส่งผลแบบ CSV ทุก N วินาที "S0001,3.85,8.42,1029.4,3.21,4.70,0.0,8.5,-0.532"
  Modbus RTU     : slave 1, input register 1 = อุณหภูมิ ×10 (int16), holding 10-11 = ปริมาณนม กก. (float32)
"""
import random
import socket
import socketserver
import struct
import threading
import time

from .devices import crc16


class _Stream(socketserver.BaseRequestHandler):
    def handle(self):
        gen = self.server.gen()
        try:
            while True:
                line = next(gen)
                if line is not None:
                    self.request.sendall(line.encode("ascii") + b"\r\n")
                time.sleep(self.server.every)
        except (OSError, StopIteration):
            pass


class _TCP(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def scale_lines(pour_kg=(18, 42), hold_s=4.0, every=0.2):
    """เทนม (แกว่ง) → นิ่ง hold_s วินาที → ยกออก (0) แล้ววนใหม่"""
    while True:
        target = round(random.uniform(*pour_kg), 1)
        for i in range(8):
            yield f"US,GS,+{target * (i + 1) / 8 + random.uniform(-0.6, 0.6):08.2f}kg"
        for _ in range(int(hold_s / every)):
            yield f"ST,GS,+{target:08.2f}kg"
        for _ in range(int(2 / every)):
            yield "ST,GS,+0000.00kg"


def analyzer_lines(every_s=20.0, step=0.5):
    n = 0
    while True:
        for _ in range(int(every_s / step) - 1):
            yield None
        n += 1
        water = 0.0 if random.random() > 0.1 else round(random.uniform(2, 6), 1)
        yield (f"S{n:04d},{random.uniform(3.3, 4.3):.2f},{random.uniform(8.1, 8.8):.2f},{random.uniform(1027, 1032):.1f},"
               f"{random.uniform(3.0, 3.5):.2f},{random.uniform(4.5, 4.9):.2f},{water},{random.uniform(5, 12):.1f},{-0.53 + water * 0.006:.3f}")


class ModbusSim(socketserver.BaseRequestHandler):
    """Modbus RTU framing over TCP (เหมือนตัวแปลง RS-485 → Ethernet แบบ transparent)"""

    def handle(self):
        buf = b""
        while True:
            try:
                chunk = self.request.recv(64)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while len(buf) >= 8:
                frame, buf = buf[:8], buf[8:]
                if crc16(frame[:6]) != frame[6:]:
                    buf = b""
                    break
                slave, fn, reg, count = struct.unpack(">BBHH", frame[:6])
                regs = self.server.registers.get((slave, fn))
                if regs is None or any(r not in regs for r in range(reg, reg + count)):
                    pdu = struct.pack(">BBB", slave, fn | 0x80, 2)
                else:
                    data = b"".join(struct.pack(">H", regs[r]) for r in range(reg, reg + count))
                    pdu = struct.pack(">BBB", slave, fn, len(data)) + data
                self.request.sendall(pdu + crc16(pdu))


def _modbus_registers(temp_c, level_kg):
    t = struct.unpack(">H", struct.pack(">h", int(round(temp_c * 10))))[0]
    hi, lo = struct.unpack(">HH", struct.pack(">f", level_kg))
    return {(1, 4): {1: t}, (1, 3): {10: hi, 11: lo}}


def start(scale_port=7001, analyzer_port=7002, modbus_port=7003, analyzer_every_s=20.0, host="127.0.0.1"):
    servers = []
    s = _TCP((host, scale_port), _Stream)
    s.gen, s.every = scale_lines, 0.2
    servers.append(s)
    a = _TCP((host, analyzer_port), _Stream)
    a.gen, a.every = (lambda: analyzer_lines(analyzer_every_s)), 0.5
    servers.append(a)
    m = _TCP((host, modbus_port), ModbusSim)
    state = {"temp": 3.8, "level": 1200.0}
    m.registers = _modbus_registers(state["temp"], state["level"])
    servers.append(m)

    def drift():
        while True:
            time.sleep(2)
            state["temp"] = min(9, max(2, state["temp"] + random.uniform(-0.1, 0.12)))
            state["level"] = max(0, state["level"] + random.uniform(5, 40))
            m.registers = _modbus_registers(state["temp"], state["level"])

    threading.Thread(target=drift, daemon=True).start()
    for srv in servers:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    return servers


def port_free(port, host="127.0.0.1"):
    with socket.socket() as so:
        return so.connect_ex((host, port)) != 0
