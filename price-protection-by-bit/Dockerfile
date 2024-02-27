FROM node:lts-alpine AS builder
RUN npm install -g npm@10.1.0
WORKDIR /app
COPY ["package.json", "package-lock.json*", "tsconfig.json",  "./"]
COPY ./src ./src
RUN npm install
RUN npm run build

FROM node:lts-alpine
ENV NODE_ENV=production
ENV PACKAGE_CONFIG=/usr/src/app/package.json
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*",  "./"]
COPY --from=builder /app/out ./out
RUN mkdir /logs
RUN chmod 777 /logs
RUN npm install --omit=dev
RUN chown -R node /usr/src/app
RUN chown -R node /logs
USER node
CMD ["npm", "start"]