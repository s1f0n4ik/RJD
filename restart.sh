sudo systemctl stop media-center && \
docker compose down && \
docker compose up -d && \
sleep 5 && \
sudo systemctl daemon-reload && \
sudo systemctl start media-center && \
echo "=== Media Center ===" && \
sudo systemctl status media-center --no-pager && \
echo -e "\n=== Docker Services ===" && \
docker compose ps
