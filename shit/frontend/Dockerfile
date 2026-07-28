# ── Build stage ──
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./

# npm ci ставит ровно дерево из lockfile. Кеш-маунт держит скачанные пакеты
# между сборками, поэтому сеть не дёргается повторно.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

COPY . .

# FULL_AUTH=true — логин на все маршруты, включая / и /kiosk.
ARG FULL_AUTH=false
RUN if [ "$FULL_AUTH" = "true" ]; then npm run build:secure; else npm run build; fi

# ── Production stage ──
FROM nginx:alpine

# Конфиг nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Сниппеты (proxy-ui.conf и т.д.)
COPY nginx/snippets/ /etc/nginx/snippets/

# Билд фронта
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
