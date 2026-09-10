FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_URL="mysql://3f88VeV8J4CXs9C.root:iIcJhD13NgCTIVmI@gateway01.ap-southeast-1.prod.aws.tidbcloud.com:4000/goldzone?sslaccept=strict"
ENV JWT_ACCESS_SECRET="goldzone-super-secret-jwt-key-minimum-32-chars-prod-2026"
ENV ACCESS_TOKEN_TTL="15m"
ENV REFRESH_TOKEN_DAYS="30"
ENV FRONTEND_ORIGIN="https://betting-fe-sable.vercel.app"
ENV FISH_ROOM_CAPACITY="6"
ENV FISH_READY_TO_START="4"
ENV FISH_START_COUNTDOWN_MS="30000"
ENV WITHDRAW_MIN="50000"
ENV WITHDRAW_MAX="100000000"
ENV EMAIL_READER_ENABLED="1"
ENV IMAP_HOST="imap.gmail.com"
ENV IMAP_PORT="993"
ENV IMAP_SECURE="1"
ENV IMAP_MAILBOX="INBOX"
ENV EMAIL_SENDER_FILTER="timo.vn"
ENV EMAIL_POLL_INTERVAL_MS="60000"
ENV EMAIL_LOOKBACK_DAYS="7"
ENV IMAP_USER="lyhotuanan2004@gmail.com"
ENV IMAP_PASSWORD="czuq lhfe laad dyeh"

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
