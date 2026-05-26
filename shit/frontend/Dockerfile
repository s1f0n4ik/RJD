# ── Build stage ──
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps
RUN npm install react-simple-keyboard

COPY . .
RUN npm run build

# ── Production stage ──
FROM nginx:alpine

# Конфиг nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Сниппеты (proxy-common.conf и т.д.)
COPY nginx/snippets/ /etc/nginx/snippets/

# Билд фронта
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]