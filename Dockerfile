# 运行镜像：单实例 Node 服务 + 持久账本 + 服务端 secret。
#
# 这个文件只是**准备好的打包材料**：本仓库不构建、不推送、不发布它。
#
# 关键约定：
# - 默认只监听 127.0.0.1；对外暴露由 HOST/代理决定，不要无脑改 0.0.0.0。
# - /app/.taste-tuner 是**持久卷**：账本（request-budget.json）与凭据文件放这里。
#   账本带锁，所以只跑**一个实例**。
# - 凭据不进镜像、不进 Git：运行时挂载。
# - 公开实例用**独立的**预算上限，别复用开发期的账本。
# - 默认接入面是**原生 HTTP 适配器**（Node 内建 fetch）：生产依赖树里没有 npm 依赖，
#   `npm ci --omit=dev` 之后 node_modules 是空的，官方 CLI 不在运行路径上。
# - Node 版本下限：生产运行 **>=22** 即可。官方 CLI 是 dev 依赖，它的 HTTP 客户端
#   （undici 8.x）要求 **>=22.19.0**——只有跑 CLI 那条路才需要这个底线。
#
# 构建：docker build -t taste-tuner .
# 运行：docker run --rm -p 4173:4173 \
#         -e HOST=0.0.0.0 -e PORT=4173 \
#         -e QLOO_ACCESS_SURFACE=http \
#         -e QLOO_REQUEST_BUDGET=<公开预算> \
#         -e QLOO_BASE_URL=https://hackathon.api.qloo.com \
#         -e QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com \
#         -v taste-tuner-state:/app/.taste-tuner \
#         taste-tuner

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tools ./tools
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=4173
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tools ./tools
COPY --from=build /app/public ./public
# 账本与凭据的落点：挂持久卷到这里。
RUN mkdir -p /app/.taste-tuner && chown -R node:node /app
USER node
VOLUME ["/app/.taste-tuner"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
