#!/usr/bin/env bash
# Перезапуск обеих ролей из исходников репозитория (машина разработки).
# На устройствах из оффлайн-пакета используются install.sh и rollback.sh.
#
# Имена проектов заданы явно: иначе обе роли попадут в один проект по имени
# каталога и down одной снесёт контейнеры другой.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

sudo systemctl stop media-center

for role in master minion; do
	COMPOSE_PROJECT_NAME="varan-$role" \
		docker compose -f "docker-compose.$role.yml" down
done

for role in master minion; do
	COMPOSE_PROJECT_NAME="varan-$role" \
		docker compose -f "docker-compose.$role.yml" up -d
done

sleep 5
sudo systemctl daemon-reload
sudo systemctl start media-center

echo "=== Media Center ==="
sudo systemctl status media-center --no-pager

for role in master minion; do
	echo -e "\n=== $role ==="
	COMPOSE_PROJECT_NAME="varan-$role" \
		docker compose -f "docker-compose.$role.yml" ps
done
