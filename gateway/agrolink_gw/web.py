"""หน้าจอเจ้าหน้าที่ศูนย์รับนม (เปิดจากแท็บเล็ต/คอมในศูนย์: http://<ip-gateway>:8080)

เลือก/สแกนรหัสสมาชิก → เทนมลงถังชั่ง → น้ำหนักนิ่ง → กด "บันทึก" (หรือ Enter)
เครื่องอ่านบัตร/QR แบบคีย์บอร์ด USB ใช้ได้เลย (พิมพ์รหัสลงช่องแล้ว Enter)
ถ้าตั้ง ui_pin ไว้ ต้องใส่ PIN ก่อนบันทึก
"""
import hmac
import json
import logging
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .app import ERR_TH

log = logging.getLogger("agrolink_gw.web")

PAGE = r"""<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>รับนม — AgroLink Gateway</title>
<style>
[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;font-family:"Noto Sans Thai","Sarabun",system-ui,sans-serif;background:#f4f6f3;color:#1d2b22}
header{background:#1f4d2e;color:#fff;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
header b{font-size:18px}.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.on{background:#3ecf6e}.off{background:#e0473f}.wait{background:#f0b429}
main{display:grid;grid-template-columns:minmax(320px,1.2fr) 1fr;gap:14px;padding:14px}@media(max-width:860px){main{grid-template-columns:1fr}}
.card{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(0,0,0,.06);padding:16px}.card h2{margin:0 0 10px;font-size:16px;color:#1f4d2e}
input{font:inherit;font-size:22px;padding:12px;border:2px solid #c9d3cc;border-radius:10px;width:100%}
.member{font-size:22px;font-weight:700;margin:10px 0 2px}.warn{background:#fde8e6;color:#a1261d;border-radius:10px;padding:10px;margin-top:8px;font-weight:600}
.weight{font-size:64px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;margin:6px 0}.weight small{font-size:22px;font-weight:600}
.st{text-align:center;font-weight:700}.btn{display:block;width:100%;border:0;border-radius:12px;padding:18px;font:inherit;font-size:24px;font-weight:800;color:#fff;background:#2c7a45;cursor:pointer;margin-top:10px}
.btn:disabled{background:#9fb5a6;cursor:not-allowed}.ghost{background:#e6ebe7;color:#1d2b22;font-size:16px;padding:10px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid #eef1ee;text-align:left}th{color:#6b7a70;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums}.pill{border-radius:20px;padding:1px 8px;font-size:12px;font-weight:700}
.p-ok{background:#ddf3e4;color:#1f6b38}.p-pending{background:#fff2cc;color:#8a5a00}.p-error{background:#fde8e6;color:#a1261d}
.msg{min-height:26px;font-weight:700;margin-top:8px}.msg.err{color:#a1261d}.msg.ok{color:#1f6b38}
.list button{display:block;width:100%;text-align:left;font:inherit;font-size:16px;padding:8px;border:0;border-bottom:1px solid #eee;background:#fff;cursor:pointer}
.tank{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eef1ee}.small{font-size:12.5px;color:#6b7a70}
</style></head><body>
<div id="pinBox" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9">
  <div class="card" style="width:320px"><h2>ใส่ PIN ของศูนย์</h2><input id="pin" type="password" inputmode="numeric"><button class="btn" id="pinBtn">เข้าใช้งาน</button><div id="pinMsg" class="msg err"></div></div></div>
<header><div><b>🐄 รับน้ำนม</b> <span id="where" class="small" style="color:#cfe3d5"></span></div><div id="net"></div></header>
<main>
<section class="card">
  <h2>1) สมาชิก</h2>
  <input id="code" placeholder="พิมพ์/สแกนรหัสสมาชิก แล้วกด Enter" autocomplete="off" autofocus>
  <div class="list" id="hits"></div>
  <div id="member" class="member">ยังไม่ได้เลือกสมาชิก</div><div id="memberSub" class="small"></div><div id="memberWarn"></div>
  <h2 style="margin-top:16px">2) ชั่งน้ำหนัก</h2>
  <div id="scales"></div>
  <button class="btn" id="capture" disabled>บันทึกน้ำหนัก (Enter)</button>
  <div id="msg" class="msg"></div>
  <button class="btn ghost" id="next">สมาชิกถัดไป</button>
</section>
<section>
  <div class="card"><h2>ถังเย็น</h2><div id="tanks" class="small">ไม่มีเซนเซอร์</div></div>
  <div class="card" style="margin-top:14px"><h2>ผลวิเคราะห์ล่าสุด</h2><div id="analyses" class="small">-</div></div>
  <div class="card" style="margin-top:14px"><h2>รายการวันนี้</h2><div id="intakes" class="small">-</div></div>
</section>
</main>
<script>
const $=s=>document.querySelector(s);const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const n2=v=>v==null?"-":Number(v).toLocaleString("th-TH",{maximumFractionDigits:2});
const ST={ok:["ส่งแล้ว","p-ok"],pending:["รอส่ง","p-pending"],error:["ไม่ผ่าน","p-error"]};
const ERR=__ERR__;const RERR={member_not_found:"ไม่พบรหัสสมาชิก",member_not_approved:"สมาชิกยังไม่อนุมัติ",round_closed:"รอบรับนมปิดแล้ว — แก้ในพอร์ทัล",channel_not_found:"ยังไม่ได้ผูกช่องนี้ในพอร์ทัล",event_too_old:"ข้อมูลเก่าเกิน 7 วัน"};
let S=null,busy=false;
async function api(p,b){const r=await fetch(p,{method:b?"POST":"GET",headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined});
  if(r.status===401){needPin=true;$("#pinBox").hidden=false;$("#pin").focus();throw new Error("pin")}
  return r.json()}
let needPin=false;
async function login(){const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pin:$("#pin").value})});
  if(r.ok){needPin=false;$("#pinBox").hidden=true;$("#pin").value="";$("#code").focus();tick()}else{$("#pin").value="";$("#pinMsg").textContent="PIN ไม่ถูกต้อง"}}
function say(t,ok){const m=$("#msg");m.textContent=t||"";m.className="msg "+(ok?"ok":"err")}
function pill(e){const [t,c]=ST[e._status]||[e._status,""];return `<span class="pill ${c}" title="${esc(RERR[e._error]||e._error||"")}">${t}</span>`}
function render(){if(!S)return;
  $("#where").textContent=[S.coop,S.center,S.name].filter(Boolean).join(" · ");
  const u=S.uplink,q=(u.queue||{}).pending||0;
  $("#net").innerHTML=`<span class="dot ${u.online?"on":"off"}"></span>${u.online?"ออนไลน์":"ออฟไลน์ (เก็บไว้ในเครื่อง)"} · รอส่ง ${q}`+(u.clock_skew_s!=null&&Math.abs(u.clock_skew_s)>120?` · <b>นาฬิกาเครื่องคลาด ${Math.round(u.clock_skew_s)} วินาที</b>`:"")+(S.has_key?"":" · <b>ยังไม่ได้ใส่คีย์</b>");
  const m=S.member;$("#member").textContent=m?`${m.code} ${m.name}`:"ยังไม่ได้เลือกสมาชิก";
  $("#memberSub").textContent=m?`วันนี้ส่งแล้ว ${n2(m.today_kg)} กก.`:(S.members_synced?`มีรายชื่อในเครื่อง ${S.members_synced} ราย`:"ยังไม่ได้ดึงรายชื่อสมาชิก");
  $("#memberWarn").innerHTML=m&&m.withdrawal?'<div class="warn">⚠️ สมาชิกมีโคอยู่ในระยะหยุดยา — นมจะถูกบันทึกเป็น "ปฏิเสธ" รอเจ้าหน้าที่ยืนยัน</div>':"";
  let can=false;$("#scales").innerHTML=S.scales.map(s=>{const ok=s.connected&&s.weight!=null;if(s.ready&&m)can=true;
    return `<div class="weight">${ok?n2(s.weight):"--"} <small>กก.</small></div><div class="st">${!s.connected?'<span style="color:#a1261d">เครื่องชั่งไม่ส่งค่า</span>':s.stable?(!s.armed?"บันทึกแล้ว — ยกถังออก":s.ready?'<span style="color:#1f6b38">นิ่ง ✓ พร้อมบันทึก</span>':"รอเทนม"):'<span style="color:#8a5a00">กำลังนิ่ง…</span>'} <span class="small">${esc(s.label)}</span></div>`}).join("")||'<div class="small">ไม่ได้ตั้งค่าเครื่องชั่ง</div>';
  $("#capture").disabled=!can||busy;
  $("#tanks").innerHTML=S.tanks.flatMap(b=>Object.entries(b.values).map(([ch,f])=>`<div class="tank"><b>${esc(ch)}</b><span>${f.temp_c?n2(f.temp_c.value)+" °C":""} ${f.level_kg?" · "+n2(f.level_kg.value)+" กก.":""}</span></div>`)).join("")||(S.tanks.length?"กำลังอ่านค่า…":"ไม่มีเซนเซอร์");
  $("#analyses").innerHTML=S.analyses.length?`<table><tr><th>เวลา</th><th>สมาชิก/ตัวอย่าง</th><th class="num">ไขมัน</th><th class="num">SNF</th><th class="num">น้ำปน</th><th></th></tr>${S.analyses.slice(0,8).map(a=>`<tr><td>${new Date(a.at).toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"})}</td><td>${esc(a.member_code||a.sample_no||"-")}</td><td class="num">${n2(a.fat_pct)}</td><td class="num">${n2(a.snf_pct)}</td><td class="num">${n2(a.added_water_pct)}</td><td>${pill(a)}</td></tr>`).join("")}</table>`:"-";
  $("#intakes").innerHTML=S.intakes.length?`<table><tr><th>เวลา</th><th>สมาชิก</th><th class="num">กก.</th><th></th></tr>${S.intakes.map(e=>`<tr><td>${new Date(e.at).toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"})}</td><td>${esc(e.member_code)}</td><td class="num">${n2(e.weight_kg)}</td><td>${pill(e)}${e._error?` <span class="small">${esc(RERR[e._error]||e._error)}</span>`:""}</td></tr>`).join("")}</table>`:"-";
}
async function tick(){if(needPin)return;try{S=await api("/api/state");render()}catch(e){if(!needPin)$("#net").innerHTML='<span class="dot off"></span>หน้าจอเชื่อมต่อ gateway ไม่ได้'}}
setInterval(tick,400);tick();
let t=null;$("#code").addEventListener("input",()=>{clearTimeout(t);const q=$("#code").value.trim();if(q.length<2){$("#hits").innerHTML="";return}
  t=setTimeout(async()=>{const r=await api("/api/members?q="+encodeURIComponent(q));$("#hits").innerHTML=r.map(m=>`<button data-c="${esc(m.code)}">${esc(m.code)} ${esc(m.name)}${m.withdrawal?" ⚠️":""}</button>`).join("")},200)});
$("#hits").addEventListener("click",e=>{const b=e.target.closest("button");if(b)pick(b.dataset.c)});
async function pick(c){clearTimeout(t);const r=await api("/api/member",{code:c});clearTimeout(t);$("#hits").innerHTML="";$("#code").value="";if(r.error)say(ERR[r.error]||r.error);else{say("");tick()}}
async function capture(){if(busy)return;busy=true;const r=await api("/api/capture",{});busy=false;if(r.error)say(ERR[r.error]||r.error);else say(`บันทึก ${n2(r.weight_kg)} กก. แล้ว`,true);tick()}
$("#capture").addEventListener("click",capture);
$("#next").addEventListener("click",async()=>{await api("/api/member",{code:""});say("");$("#code").focus();tick()});
$("#pinBtn").addEventListener("click",login);
document.addEventListener("keydown",e=>{if(e.key!=="Enter")return;if(needPin){e.preventDefault();login();return}const v=$("#code").value.trim();e.preventDefault();if(v)pick(v);else if(!$("#capture").disabled)capture()});
</script></body></html>"""


def make_handler(gw):
    pin = gw.cfg.get("ui_pin") or ""
    sessions = set()
    page = PAGE.replace("__ERR__", json.dumps(ERR_TH, ensure_ascii=False)).encode("utf-8")

    class H(BaseHTTPRequestHandler):
        server_version = "agrolink-gw"

        def log_message(self, fmt, *args):  # quiet
            log.debug("ui %s", fmt % args)

        def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _authed(self):
            if not pin:
                return True
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "gwsid" and v in sessions:
                    return True
            return False

        def _body(self):
            n = min(int(self.headers.get("Content-Length") or 0), 10000)
            try:
                return json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return {}

        def do_GET(self):  # noqa: N802
            path, _, qs = self.path.partition("?")
            if path == "/":
                return self._send(200, page, "text/html; charset=utf-8")
            if path.startswith("/api/") and not self._authed():
                return self._send(401, {"error": "pin_required"})
            if path == "/api/state":
                return self._send(200, gw.state())
            if path == "/api/members":
                from urllib.parse import parse_qs
                q = (parse_qs(qs).get("q") or [""])[0][:40]
                return self._send(200, gw.store.search_members(q) if len(q) >= 1 else [])
            if path == "/healthz":
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not_found"})

        def do_POST(self):  # noqa: N802
            b = self._body()
            if self.path == "/api/login":
                if pin and hmac.compare_digest(str(b.get("pin", "")), pin):
                    sid = secrets.token_hex(16)
                    sessions.add(sid)
                    return self._send(200, {"ok": True}, extra={"Set-Cookie": f"gwsid={sid}; HttpOnly; SameSite=Strict; Path=/"})
                return self._send(401, {"error": "bad_pin"})
            if not self._authed():
                return self._send(401, {"error": "pin_required"})
            if self.path == "/api/member":
                m, err = gw.select_member(b.get("code"))
                return self._send(200, {"error": err} if err else {"member": m})
            if self.path == "/api/capture":
                ev, err = gw.capture(b.get("channel"))
                return self._send(200, {"error": err} if err else ev)
            return self._send(404, {"error": "not_found"})

    return H


def serve(gw):
    srv = ThreadingHTTPServer((gw.cfg["ui_host"], gw.cfg["ui_port"]), make_handler(gw))
    srv.daemon_threads = True
    return srv
