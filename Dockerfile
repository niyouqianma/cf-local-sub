FROM node:22-slim

ARG CFST_VERSION=v2.3.5
ARG TARGETARCH

ENV TZ=Asia/Shanghai \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CFST_BIN=/app/bin/cfst

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /app/bin /data \
    && arch="${TARGETARCH:-amd64}" \
    && case "${arch}" in \
         amd64|arm64) cfst_arch="${arch}" ;; \
         386) cfst_arch="386" ;; \
         *) echo "Unsupported arch: ${arch}" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/XIU2/CloudflareSpeedTest/releases/download/${CFST_VERSION}/cfst_linux_${cfst_arch}.tar.gz" -o /tmp/cfst.tar.gz \
    && tar -xzf /tmp/cfst.tar.gz --strip-components=1 -C /app/bin \
    && chmod +x /app/bin/cfst \
    && rm -f /tmp/cfst.tar.gz

COPY package.json ./
COPY src ./src
COPY public ./public

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
