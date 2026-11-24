#!/usr/bin/env bash
# ติดตั้ง AgroLink Gateway บน Gateway อุตสาหกรรมที่ใช้ Debian/Ubuntu (ไม่ใช้ Docker)
# วิธีใช้ (บน Gateway, ในโฟลเดอร์ที่มีไฟล์นี้):  sudo bash install.sh
# รันซ้ำได้ (ใช้อัปเดตเวอร์ชันด้วย) — ไม่ทับไฟล์ตั้งค่าและคีย์ที่มีอยู่
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "ต้องรันด้วย sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/agrolink-gw; ETC=/etc/agrolink-gw; DATA=/var/lib/agrolink-gw

echo "==> ติดตั้ง Python"
if command -v apt-get >/dev/null; then
  apt-get update -qq && apt-get install -y -qq python3 python3-venv >/dev/null
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "ต้องใช้ Python 3.9 ขึ้นไป"; exit 1; }

echo "==> ผู้ใช้ระบบ agrolink-gw (อยู่กลุ่ม dialout เพื่อใช้ช่อง Serial)"
id agrolink-gw >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin agrolink-gw
usermod -aG dialout agrolink-gw

echo "==> คัดลอกโปรแกรมไปที่ $APP"
mkdir -p "$APP" "$ETC" "$DATA"
rm -rf "$APP/agrolink_gw"
cp -r "$SRC/agrolink_gw" "$SRC/requirements.txt" "$SRC/config.example.toml" "$APP/"
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"

if [ ! -f "$ETC/config.toml" ]; then
  cp "$SRC/config.example.toml" "$ETC/config.toml"
  echo "==> สร้าง $ETC/config.toml จากตัวอย่าง — ต้องแก้ port/channel ให้ตรงอุปกรณ์"
fi
chown -R agrolink-gw:dialout "$DATA"; chmod 700 "$DATA"
chmod 644 "$ETC/config.toml"

cat > /usr/local/bin/agrolink-gw <<CMD
#!/bin/sh
# คำสั่งที่แตะคีย์/คิวรันในนามผู้ใช้ agrolink-gw ไฟล์จึงเป็นของบริการเสมอ
export AGROLINK_GW_CONFIG=$ETC/config.toml
export PYTHONPATH=$APP
case "\$1" in run|sim) exec $APP/venv/bin/python -m agrolink_gw "\$@";; esac
exec sudo -u agrolink-gw -E env PYTHONPATH=$APP $APP/venv/bin/python -m agrolink_gw "\$@"
CMD
chmod 755 /usr/local/bin/agrolink-gw

if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  install -m 644 "$SRC/deploy/agrolink-gw.service" /etc/systemd/system/agrolink-gw.service
  systemctl daemon-reload
  systemctl enable agrolink-gw >/dev/null
  if [ -f "$DATA/device.key" ]; then systemctl restart agrolink-gw; echo "==> เริ่มบริการใหม่แล้ว"; fi
else
  echo "!! เครื่องนี้ไม่มี systemd — ให้เริ่มด้วย: agrolink-gw run (หรือใช้ Docker แทน)"
fi

timedatectl set-ntp true 2>/dev/null || true
timedatectl set-timezone Asia/Bangkok 2>/dev/null || true

cat <<MSG

ติดตั้งเสร็จ ขั้นต่อไป:
  1) sudo nano $ETC/config.toml        แก้ port และ channel ให้ตรงอุปกรณ์จริง
  2) sudo agrolink-gw test-scale       ดูว่าอ่านน้ำหนักได้ (test-analyzer / test-modbus ด้วย)
  3) sudo agrolink-gw setup            วางคีย์ Gateway จากพอร์ทัลสหกรณ์ (แท็บ IoT)
  4) sudo systemctl restart agrolink-gw
  5) เปิดหน้าจอรับนม  http://<ip-ของ-gateway>:8080
ดู log: journalctl -u agrolink-gw -f      สถานะคิว: sudo agrolink-gw status
MSG
