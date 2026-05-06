FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps
RUN npm install react-simple-keyboard

COPY . .

# Build с заменой переменных окружения
ARG VITE_SIGNALING_SERVER=ws://192.168.1.2:8765
ARG VITE_FASTAPI_BASE=http://192.168.1.2:8000

ENV VITE_SIGNALING_SERVER=$VITE_SIGNALING_SERVER
ENV VITE_FASTAPI_BASE=$VITE_FASTAPI_BASE

RUN npm run build

# Production stage
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]