#!/usr/bin/env bash
# Network tuning for a Linux gateway VM (run once as root). Safe defaults:
# BBR congestion control, bigger socket buffers, faster reuse of closed connections.
set -euo pipefail
cat > /etc/sysctl.d/90-tervyn.conf <<'CONF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_notsent_lowat = 16384
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.core.somaxconn = 8192
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_tw_reuse = 1
net.core.rmem_default = 2500000
CONF
sysctl --system >/dev/null
echo "Applied. Congestion control: $(sysctl -n net.ipv4.tcp_congestion_control)"
