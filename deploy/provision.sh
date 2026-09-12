#!/usr/bin/env bash
#
# Prepare a fresh box to run Rally. Run once, on Ubuntu 22.04+, as root or via a
# user with passwordless sudo:
#
#   ssh <host> 'sudo bash -s' < deploy/provision.sh
#
# Installs Docker, adds swap, opens the firewall, and leaves a .env for you to
# fill in. It does not fetch the code — deploy.sh does that. Safe to re-run.

set -euo pipefail

log() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root (ssh <host> 'sudo bash -s' < deploy/provision.sh)" >&2
  exit 1
fi

# ── Docker ────────────────────────────────────────────────────────────────────

if command -v docker >/dev/null 2>&1; then
  log "Docker is already installed"
else
  log "Installing Docker from Docker's own apt repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" \
    "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

# ── Swap ──────────────────────────────────────────────────────────────────────
#
# The image is built on this box, and bundling the display app peaks well above
# what a 1 GB instance has free. Without swap that build is killed by the OOM
# reaper, which reports itself as a mystifying "exit code 137" halfway through.
# A box with real memory does not need the help.

mem_mb="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"
if [ "${mem_mb:-0}" -ge 3000 ]; then
  log "${mem_mb} MB of RAM — skipping swap"
elif swapon --show=NAME --noheadings | grep -qx /swapfile; then
  log "Swap is already configured"
else
  log "Adding 2 GB of swap so the build survives on a 1 GB box"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -qx '/swapfile none swap sw 0 0' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── Firewall ──────────────────────────────────────────────────────────────────

#
# Two different worlds, and picking the wrong one loses you the box.
#
# A stock cloud image usually ships an inactive ufw and expects you to turn it
# on. Oracle's Ubuntu images do not: they ship a raw iptables ruleset whose last
# INPUT rule REJECTs everything, with a single hole punched for SSH. Running
# `ufw enable` on top of that stacks a second firewall over the first and is an
# excellent way to end up locked out of a machine you cannot console into.
#
# So detect what is actually in charge.

open_ports_iptables() {
  local cmd="$1"
  # Insert ABOVE the catch-all REJECT rather than appending below it, where the
  # rule would be correct, present, and never reached.
  local reject
  reject="$("$cmd" -L INPUT --line-numbers -n 2>/dev/null | awk '$2=="REJECT"{print $1; exit}')"
  for port in 80 443; do
    if "$cmd" -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
      log "$cmd: ${port}/tcp already open"
      continue
    fi
    if [ -n "$reject" ]; then
      "$cmd" -I INPUT "$reject" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else
      "$cmd" -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
    log "$cmd: opened ${port}/tcp"
  done
}

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi "Status: active"; then
  log "ufw is active — adding 80 and 443 to it"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
elif iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  log "Raw iptables with a catch-all REJECT (Oracle Cloud and friends)"
  open_ports_iptables iptables
  if ip6tables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
    open_ports_iptables ip6tables
  fi
  # Survive a reboot.
  if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
    echo 'iptables-persistent iptables-persistent/autosave_v4 boolean false' | debconf-set-selections
    echo 'iptables-persistent iptables-persistent/autosave_v6 boolean false' | debconf-set-selections
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent
  fi
  netfilter-persistent save >/dev/null 2>&1 && log "Firewall rules saved for reboot"
elif command -v ufw >/dev/null 2>&1; then
  # ufw present but inactive and nothing else is filtering: turn it on, reading
  # the real SSH port rather than assuming 22.
  ssh_port="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  ssh_port="${ssh_port:-22}"
  log "Enabling ufw for ${ssh_port}/tcp (ssh), 80 and 443"
  ufw allow "${ssh_port}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
else
  log "No host firewall found; relying on the cloud one"
fi

# rsync is how deploy.sh gets the code here.
command -v rsync >/dev/null 2>&1 || apt-get install -y -qq rsync

# ── Where the app lives ───────────────────────────────────────────────────────

mkdir -p /opt/rally/deploy

if [ -f /opt/rally/deploy/.env ]; then
  log "Keeping the existing /opt/rally/deploy/.env"
else
  log "Writing a starter /opt/rally/deploy/.env"
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  cat > /opt/rally/deploy/.env <<EOF
# The hostname Caddy gets a certificate for, and the origin every QR code and
# invite link is built from. Point a DNS record at ${ip} and put it here.
#
# No domain? sslip.io resolves any dashed IP to that IP, with no DNS setup, and
# Let's Encrypt will issue a certificate for it:
RALLY_DOMAIN=${ip//./-}.sslip.io

# Optional. Without them the offline writer and the browser's own voice take
# over, and nothing breaks except the quality of the jokes.
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_CONCURRENCY=3
EOF
  chmod 600 /opt/rally/deploy/.env
fi

# rsync arrives as the login user, not as root, so give them the directory.
owner="${SUDO_USER:-root}"
chown -R "$owner":"$owner" /opt/rally
chmod 600 /opt/rally/deploy/.env

cat <<EOF

Provisioned. Next, from your laptop:

  deploy/deploy.sh root@${SSH_CONNECTION:+$(echo "$SSH_CONNECTION" | awk '{print $3}')}

Edit /opt/rally/deploy/.env first if you want a real domain or API keys.
The default uses sslip.io, which needs no DNS at all.
EOF
