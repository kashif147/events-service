FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

RUN apk add --no-cache curl git

WORKDIR /app

# Dependencies install from the committed lockfile (npm ci), so source + lockfile + image describe the
# same dependency set. The July 2026 workaround (package.json only + npm install) is retired: the npm
# reify crash with --omit=dev no longer reproduces with the reconciled lockfile in this pinned base image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4011

CMD ["npm", "start"]
