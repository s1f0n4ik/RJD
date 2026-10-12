import json
import logging
from pathlib import Path
from typing import Annotated, Optional

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)

# Код записи 28163: 0–10 по словарю Искры
Code = Annotated[int, Field(ge=0, le=10)]
# Роль камеры Искры: 1 дальняя, 2 ближняя, 3 левая, 4 правая, 0 — без роли
Role = Annotated[int, Field(ge=0, le=4)]


class Stitch(BaseModel):
    # Пауза между пропажей трека и появлением нового, который сшивается с ним
    gap_s: float = Field(2.0, ge=0, le=60)
    # Допустимое смещение центра нового трека в диагоналях последней рамки прежнего
    distance: float = Field(1.0, ge=0, le=10)


class ClassFilter(BaseModel):
    enabled: bool = True
    classes_all: bool = True
    # Имена классов и ключи суперклассов
    classes: list[str] = []

    def allows(self, class_name: str, superclass: str) -> bool:
        return self.classes_all or class_name in self.classes or bool(superclass) and superclass in self.classes


class WebSocketModule(ClassFilter):
    # Кадр, пришедший позже открытия обнаружения на это время, в ЦПУ не уходит
    late_s: float = Field(5.0, ge=0, le=60)


class CanModule(ClassFilter):
    pass


class ModbusModule(BaseModel):
    enabled: bool = True
    # Запись уходит при закрытии обнаружения, но не позже этого времени после открытия
    ceiling_s: float = Field(30.0, ge=1, le=3600)
    # Класс модели → код 28163; класса нет — только журнал
    codes: dict[str, Code] = {"Человек": 0, "Автомобиль": 3, "Грузовик": 4}
    # id камеры → роль
    roles: dict[str, Role] = {}


class RsmSettings(BaseModel):
    stitch: Stitch = Stitch()
    websocket: WebSocketModule = WebSocketModule()
    can: CanModule = CanModule()


class IskraSettings(BaseModel):
    stitch: Stitch = Stitch()
    modbus: ModbusModule = ModbusModule()


class RulesStore:
    # Настройки правил по конфигурациям: rules/<id>.json, нет файла — умолчания
    def __init__(self, root: Path):
        self.root = root / "rules"

    def _path(self, config_id: str) -> Path:
        return self.root / f"{config_id}.json"

    def load(self, config_id: str, model: type[BaseModel]) -> BaseModel:
        path = self._path(config_id)
        try:
            return model.model_validate(json.loads(path.read_text(encoding="utf-8")))
        except FileNotFoundError:
            return model()
        except (OSError, ValueError, ValidationError) as e:
            logger.warning("rules %s unreadable, defaults used: %s", path, e)
            return model()

    def save(self, config_id: str, settings: BaseModel) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(config_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(settings.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    # Время последнего сохранения, unix мс; None — работают умолчания
    def saved_at(self, config_id: str) -> Optional[int]:
        try:
            return int(self._path(config_id).stat().st_mtime * 1000)
        except OSError:
            return None
