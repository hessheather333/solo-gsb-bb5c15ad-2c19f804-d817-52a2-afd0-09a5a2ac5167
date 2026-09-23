# ---------- 构建阶段：安装依赖并打包 ----------
FROM node:20-alpine AS build
WORKDIR /app

# 先拷贝依赖清单，充分利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段：仅包含静态产物与零依赖服务器 ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4173 \
    HOST=0.0.0.0

COPY --from=build /app/dist ./dist
COPY server.mjs ./

EXPOSE 4173
CMD ["node", "server.mjs"]
