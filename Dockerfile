# syntax=docker/dockerfile:1

# Match local dev (Node 26) to rule out V8/engine skew in pdfjs-dist parsing.
# pdfjs-dist requires Node >=22.13.0.
ARG NODE_VERSION=26-alpine

FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat

# ---- Dependencies ----
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# sharp is only next's optional peer dep for the next/image optimizer route,
# which this app never uses (no next/image import anywhere in src/) — drop it
# entirely rather than just pruning its arch variants.
RUN rm -rf node_modules/sharp node_modules/@img

# npm's optional-dependency libc detection can pull in both the glibc and
# musl native builds for @napi-rs/canvas even though this image only ever
# runs the musl (Alpine) variant — strip the dead one. (@napi-rs/canvas
# itself is load-bearing: pdfjs-dist's legacy Node build does `new
# DOMMatrix()` at module scope and crashes without the polyfill it provides.)
RUN find node_modules/@napi-rs -maxdepth 1 -type d \
      \( -name '*-linux-*' -o -name '*-darwin-*' -o -name '*-win32-*' -o -name '*-android-*' -o -name '*-freebsd-*' \) \
      ! -iname '*musl*' -exec rm -rf {} + 2>/dev/null || true

# ---- Build ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Runtime ----
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# App traffic on 3000; Prometheus scrapes metrics off 9464/metrics.
EXPOSE 3000 9464

CMD ["node", "server.js"]
