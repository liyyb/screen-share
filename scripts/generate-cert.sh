#!/usr/bin/env bash
# 生成自签 HTTPS 证书，用于局域网跨设备演示。
# 用法: bash scripts/generate-cert.sh <主机IP或域名>
# 例:   bash scripts/generate-cert.sh 192.168.1.10
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "用法: bash scripts/generate-cert.sh <主机IP或域名>"
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$DIR/certs"
mkdir -p "$CERT_DIR"

cat > "$CERT_DIR/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = $HOST
[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt_names]
IP.1 = $HOST
DNS.1 = localhost
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -config "$CERT_DIR/openssl.cnf" 2>/dev/null

echo "已生成:"
echo "  $CERT_DIR/cert.pem"
echo "  $CERT_DIR/key.pem"
echo ""
echo "启动服务:"
echo "  HOST=0.0.0.0 PUBLIC_ORIGIN=https://$HOST:3000 \\"
echo "    TLS_CERT_FILE=$CERT_DIR/cert.pem TLS_KEY_FILE=$CERT_DIR/key.pem \\"
echo "    node server/main.mjs"
echo ""
echo "每台观看设备需信任 cert.pem："
echo "  Windows: 双击 cert.pem → 安装证书 → 本地计算机 → 受信任的根证书颁发机构"
echo "  Android: 设置 → 安全 → 从设备存储安装；或 Chrome 访问后点‘继续’（部分版本）"
echo "  iOS:     通过邮件/文件打开 cert.pem 描述文件，安装并信任"
