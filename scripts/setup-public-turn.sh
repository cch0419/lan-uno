#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
trap 'printf "TURN setup stopped at line %s. Do not share credential files.\n" "$LINENO" >&2' ERR

UNO_PROJECT_DIR=/root/workspace/uno
UNO_PUBLIC_IP=39.104.71.170
UNO_SETTINGS_DIR=/etc/lan-uno
UNO_ENV_FILE="$UNO_SETTINGS_DIR/voice.env"
UNO_OVERRIDE="$UNO_PROJECT_DIR/compose.override.yaml"

if [ "$EUID" -ne 0 ]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [ ! -f "$UNO_PROJECT_DIR/compose.yaml" ]; then
  echo "Missing /root/workspace/uno/compose.yaml." >&2
  exit 1
fi
if [ -n "${COMPOSE_FILE:-}" ]; then
  echo "COMPOSE_FILE is set. Check the active Compose configuration before continuing." >&2
  exit 1
fi
for UNO_OTHER_OVERRIDE in "$UNO_PROJECT_DIR/compose.override.yml" "$UNO_PROJECT_DIR/docker-compose.override.yml" "$UNO_PROJECT_DIR/docker-compose.override.yaml"; do
  if [ -e "$UNO_OTHER_OVERRIDE" ]; then
    echo "Another Compose override exists. Merge its settings before using this script." >&2
    exit 1
  fi
done
if [ -e "$UNO_OVERRIDE" ] && ! grep -q '^# Managed by LAN UNO TURN setup$' "$UNO_OVERRIDE"; then
  echo "compose.override.yaml already exists. It has not been overwritten." >&2
  exit 1
fi
if grep -q 'UNO_VOICE_ICE_SERVERS' "$UNO_PROJECT_DIR/compose.yaml"; then
  echo "compose.yaml already defines UNO_VOICE_ICE_SERVERS. Review that setting first." >&2
  exit 1
fi
if systemctl is-active --quiet coturn && [ ! -f "$UNO_ENV_FILE" ]; then
  echo "An existing coturn service is running. Review its configuration before replacing it." >&2
  exit 1
fi

cd "$UNO_PROJECT_DIR"
docker compose version
docker compose config --quiet
UNO_PRIVATE_IP="$(ip -4 route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
if [[ ! "$UNO_PRIVATE_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Could not detect the server IPv4 address." >&2
  exit 1
fi
printf 'Public IPv4: %s; relay interface IPv4: %s\n' "$UNO_PUBLIC_IP" "$UNO_PRIVATE_IP"

apt-get update
apt-get install -y coturn openssl
systemctl stop coturn
install -d -m 0700 "$UNO_SETTINGS_DIR"
UNO_BACKUP_SUFFIX="$(date +%Y%m%d-%H%M%S)"
if [ -f /etc/turnserver.conf ]; then
  cp -p /etc/turnserver.conf "$UNO_SETTINGS_DIR/turnserver-before-$UNO_BACKUP_SUFFIX.conf"
  chmod 0600 "$UNO_SETTINGS_DIR/turnserver-before-$UNO_BACKUP_SUFFIX.conf"
fi
if [ -f "$UNO_ENV_FILE" ]; then
  cp -p "$UNO_ENV_FILE" "$UNO_SETTINGS_DIR/voice-before-$UNO_BACKUP_SUFFIX.env"
fi
cp -p compose.yaml "$UNO_SETTINGS_DIR/compose-before-$UNO_BACKUP_SUFFIX.yaml"

UNO_TURN_PASSWORD="$(openssl rand -hex 24)"
cat > /etc/turnserver.conf <<EOF
listening-port=3478
listening-ip=0.0.0.0
relay-ip=$UNO_PRIVATE_IP
external-ip=$UNO_PUBLIC_IP/$UNO_PRIVATE_IP
min-port=49152
max-port=65535
fingerprint
lt-cred-mech
realm=$UNO_PUBLIC_IP
user=uno:$UNO_TURN_PASSWORD
user-quota=400
total-quota=400
max-bps=64000
no-tls
no-dtls
no-tcp-relay
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
chown root:turnserver /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf

cat > "$UNO_ENV_FILE" <<EOF
UNO_VOICE_ICE_SERVERS=[{"urls":"stun:$UNO_PUBLIC_IP:3478"},{"urls":["turn:$UNO_PUBLIC_IP:3478?transport=udp","turn:$UNO_PUBLIC_IP:3478?transport=tcp"],"username":"uno","credential":"$UNO_TURN_PASSWORD"}]
EOF
chmod 0600 "$UNO_ENV_FILE"
unset UNO_TURN_PASSWORD

cat > "$UNO_OVERRIDE" <<'EOF'
# Managed by LAN UNO TURN setup
services:
  uno:
    env_file:
      - /etc/lan-uno/voice.env
EOF
chmod 0644 "$UNO_OVERRIDE"

if [ -f /etc/default/coturn ]; then
  if grep -Eq '^#?[[:space:]]*TURNSERVER_ENABLED=' /etc/default/coturn; then
    sed -i 's/^#\?[[:space:]]*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  else
    printf '\nTURNSERVER_ENABLED=1\n' >> /etc/default/coturn
  fi
fi

if command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status | grep -q '^Status: active'; then
  ufw allow 3478/tcp
  ufw allow 3478/udp
  ufw allow 49152:65535/udp
fi

systemctl enable coturn
systemctl restart coturn
systemctl is-active --quiet coturn
docker compose config --quiet
docker compose up -d --no-build --force-recreate uno
docker compose ps
docker compose exec -T uno node -e 'const servers=JSON.parse(process.env.UNO_VOICE_ICE_SERVERS || "[]"); const urls=servers.flatMap(s=>Array.isArray(s.urls)?s.urls:[s.urls]); console.log(JSON.stringify({iceServerCount:servers.length,urls},null,2)); if(!urls.some(u=>u.startsWith("turn:"))) process.exit(1);'
printf '\nTURN configuration is ready. Open the Alibaba Cloud security-group ports, then refresh both browsers and rejoin voice.\n'