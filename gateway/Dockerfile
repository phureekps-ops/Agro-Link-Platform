# AgroLink Gateway — สำหรับ Gateway อุตสาหกรรมที่รัน Docker ได้ (ARM64 / ARMv7 / x86-64)
#   docker build -t agrolink-gw .                       (หรือ docker buildx build --platform linux/arm64,linux/arm/v7,linux/amd64)
#   ดูวิธีรันใน docker-compose.yml และ README.md
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Bangkok AGROLINK_GW_CONFIG=/data/config.toml
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --system --uid 10001 --gid dialout --home /data agrolink
COPY agrolink_gw ./agrolink_gw
COPY config.example.toml ./
USER agrolink
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=4)"
ENTRYPOINT ["python", "-m", "agrolink_gw"]
CMD ["run"]
