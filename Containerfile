FROM docker.io/library/node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN rm -rf dist && NODE_ENV=production npx webpack --config webpack.config.js

FROM docker.io/library/nginx:1.27-alpine

RUN chmod -R 777 /var/cache/nginx /var/run /var/log/nginx /usr/share/nginx/html /etc/nginx

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

USER 1001

ENTRYPOINT ["nginx", "-g", "daemon off;"]
