#!/bin/sh
# ReqSlate —— 不用 Docker 时的启动脚本（Linux / macOS）
# 用法：./start.sh
# 可选环境变量：PORT（默认 3000）、DATA_DIR（默认 ./data）、ADMIN_PASSWORD（默认 admin123）

cd "$(dirname "$0")" || exit 1

: "${PORT:=3000}"
: "${ADMIN_PASSWORD:=admin123}"
export PORT ADMIN_PASSWORD

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 node 命令。这个程序需要 Node.js 24（或 22.5 以上）。"
  echo "  下载：https://nodejs.org/zh-cn/download"
  echo "  免安装版解压后，把 node 所在目录加进 PATH 再运行本脚本。"
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "  当前 Node 版本：$(node -v)"
  echo "  需要 Node.js 24（或 22.5 以上，会自动加 --experimental-sqlite）。"
  echo "  下载：https://nodejs.org/zh-cn/download"
  echo ""
  exit 1
fi

echo ""
echo "  ReqSlate 工作任务清单"
echo "  ----------------------------------------"
echo "  访问地址： http://127.0.0.1:${PORT}"
echo "  管理密码： ${ADMIN_PASSWORD}"
echo "  数据目录： ${DATA_DIR:-./data}"
echo ""
echo "  提示：要发给别人的链接，请用本机 IP 打开首页再复制"
echo "  停止：  Ctrl+C"
echo ""

exec node server.js
