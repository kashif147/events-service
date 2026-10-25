FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

RUN apk add --no-cache curl git

WORKDIR /app

# package-lock.json is deliberately NOT copied here: reifying it with
# --omit=dev triggers a reproducible npm bug ("Cannot destructure property
# 'package' of 'node.target'") in a clean container, most likely from
# nodemon's macOS-only optional fsevents dependency interacting with
# --omit=dev pruning. Resolving fresh from package.json avoids it; the git
# dependencies are already pinned to branches for reproducibility.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4011

CMD ["npm", "start"]
