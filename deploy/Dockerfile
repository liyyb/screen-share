# SHARE 信令服务镜像（零第三方依赖，仅需 Node 运行时）
FROM node:22-alpine
WORKDIR /app

# 只拷贝运行所需：server（含预检/路由/存储）与 public（前端静态资源）
COPY server/ ./server/
COPY public/ ./public/

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/main.mjs"]
