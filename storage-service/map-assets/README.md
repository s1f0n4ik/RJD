# Офлайн-карта для журнала обнаружений

Карта работает полностью без интернета: MapLibre берёт стиль, глифы и векторные
тайлы с того же origin, через storage-service. Ниже — что и куда положить.

## Что должно оказаться на устройстве

```
/storage/journal/
  tiles/russia.mbtiles          # векторные тайлы (схема OpenMapTiles)
  map/style.json                # стиль (файл из этой папки)
  map/glyphs/<fontstack>/<range>.pbf   # шрифты для подписей
  map/sprite/sprite.json|.png          # опционально, иконки стиля
```

Пути настраиваются в `app/config.py`: `JOURNAL_TILES_MBTILES` и `JOURNAL_MAP_DIR`.

## 1. Тайлы: генерируем сами из OpenStreetMap

Исходные данные — выгрузка Geofabrik (бесплатно, лицензия ODbL):

```bash
wget https://download.geofabrik.de/russia-latest.osm.pbf
```

Превращаем в векторные тайлы через planetiler (нужна Java):

```bash
wget https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
java -Xmx8g -jar planetiler.jar \
  --osm-path=russia-latest.osm.pbf \
  --output=russia.mbtiles \
  --maxzoom=14
```

Памяти нужно порядка 2× от размера `.pbf`; считается десятки минут. Результат
кладём в `/storage/journal/tiles/russia.mbtiles`.

Альтернатива при нехватке RAM — `tilemaker` (медленнее, но легче по памяти).

## 2. Глифы: готовые шрифты

Подписи не отрисуются без глифов. Берём готовые из репозитория OpenMapTiles:

```bash
git clone --depth 1 https://github.com/openmaptiles/fonts.git
# нужны те fontstack'и, что указаны в style.json
cp -r fonts/noto-sans/* /storage/journal/map/glyphs/
```

`style.json` использует `Noto Sans Regular` и `Noto Sans Bold` — каталоги с
такими именами должны лежать в `map/glyphs/`.

## 3. Стиль

```bash
cp style.json /storage/journal/map/style.json
```

Стиль тёмный, под тему раздела (slate + iris): железные дороги подсвечены синим,
всё остальное приглушено, чтобы цветные точки обнаружений читались поверх.
Спрайты не обязательны — в стиле нет иконочных слоёв.

## Лицензия

Данные OpenStreetMap распространяются по ODbL: атрибуция `© OpenStreetMap`
обязательна и уже добавлена в стиль и в контрол карты.
