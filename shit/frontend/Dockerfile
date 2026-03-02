cd ~/RJD/RJD/shit/frontend

# Создать production Dockerfile
cat > Dockerfile << 'DOCKERFILE'
FROM node:20-alpine AS build

WORKDIR /app

# Установка зависимостей
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Копируем код
COPY . .

# Production build
RUN npm run build

# Production stage - Nginx
FROM nginx:alpine

# Копируем build
COPY --from=build /app/dist /usr/share/nginx/html

# Nginx конфигурация
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
DOCKERFILE

# Создать nginx.conf
cat > nginx.conf << 'NGINX'
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Проксируем API запросы
    location /api/ {
        proxy_pass http://fastapi:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket
    location /ws {
        proxy_pass http://fastapi:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
NGINX