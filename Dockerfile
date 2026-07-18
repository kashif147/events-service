FROM node:22-alpine

RUN apk add --no-cache curl git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 4011

CMD ["npm", "start"]
