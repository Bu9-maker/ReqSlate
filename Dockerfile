# ReqSlate —— 单容器镜像
#
# 基础镜像自带 Node 24，node:sqlite 开箱可用，不需要 npm install、不需要联网。
# node:24-alpine 官方是多架构镜像：在 x86 服务器上构建得到 amd64，
# 在鲲鹏/飞腾/树莓派这类 ARM 机器上构建得到 arm64，不用改任何东西。
FROM node:24-alpine

WORKDIR /app

# 只拷运行真正需要的东西。测试脚本、演示数据、截图由 .dockerignore 挡在外面。
COPY server.js ./
COPY xlsx.js ./
COPY config.json ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/reqslate-entrypoint

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 3000

RUN addgroup -S app && adduser -S app -G app \
 && mkdir -p /data && chown -R app:app /app /data \
 && chmod +x /usr/local/bin/reqslate-entrypoint

# 入口脚本负责把挂进来的数据目录交给 app 用户，然后降权执行 node。
# 不直接 USER app 的原因见 docker-entrypoint.sh 里的注释。
ENTRYPOINT ["/usr/local/bin/reqslate-entrypoint"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
