#!/bin/sh
# ReqSlate 容器启动脚本
#
# 为什么需要它：docker compose 把宿主机的 ./data 挂到容器的 /data，
# 那个目录通常是 root 拥有的，而镜像里是用非 root 的 app 用户跑 Node，
# 写不进去就会报「数据目录不可写」然后退出。构建时的 chown 管不到它，
# 因为卷是运行时挂上去的，会把镜像里那个目录整个盖住。
#
# 所以：用 root 进来 → 把数据目录交给 app → 降权跑 Node。
# 直接用 `node server.js`（不用 Docker）时这个脚本不参与，互不影响。
set -e

DATA="${DATA_DIR:-/data}"
cd /app

if [ "$(id -u)" = "0" ] && command -v su >/dev/null 2>&1; then
  mkdir -p "$DATA"
  # 授权失败不致命（比如只读挂载），交给 server.js 报出更清楚的错误
  chown -R app:app "$DATA" 2>/dev/null || true

  # alpine 的 su 来自 busybox，会保留环境变量，所以 PORT / DATA_DIR /
  # ADMIN_PASSWORD 这些不用手动搬，密码也就不会出现在 ps 的命令行里。
  # 万一换了基镜像、新 su 把环境清空了，下面这句会喊一声，
  # 不至于让管理密码悄悄回落成默认值。
  exec su -s /bin/sh app -c '
    cd /app
    [ -n "$ADMIN_PASSWORD" ] || echo "  [warn] 环境变量丢了，管理密码回落到默认值，请检查 docker-compose.yml"
    exec node /app/server.js
  '
fi

if [ "$(id -u)" = "0" ]; then
  echo '  [warn] 容器里没有 su 命令，退回 root 身份运行（功能正常，隔离弱一些）'
fi

exec node /app/server.js
