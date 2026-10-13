import json
import logging
from pathlib import Path
from typing import Annotated, Optional

from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

# Код записи 28163: 0–10 по словарю Искры
Code = Annotated[int, Field(ge=0, le=10)]
# Роль камеры Искры: 1 дальняя, 2 ближняя, 3 левая, 4 правая, 0 — без роли
Role = Annotated[int, Field(ge=0, le=4)]
# Тип обнаружения CAN 1–8 и класс опасности 1–4; 0 — не задано
CanType = Annotated[int, Field(ge=0, le=8)]
Danger = Annotated[int, Field(ge=0, le=4)]
# Номер камеры CAN в байте 4
CameraNo = Annotated[int, Field(ge=1, le=8)]


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


class ClassRule(BaseModel):
    type: CanType = 0
    danger: Danger = 0


class RsmDefaults(BaseModel):
    type: int = Field(8, ge=1, le=8)
    danger: int = Field(1, ge=1, le=4)


class RsmTable(BaseModel):
    # Класс без своего правила и суперкласса
    defaults: RsmDefaults = RsmDefaults()
    # Ключ суперкласса → класс опасности
    superclasses: dict[str, Danger] = {}
    # Имя класса → тип и опасность
    classes: dict[str, ClassRule] = {}
    # id камеры → номер
    cameras: dict[str, CameraNo] = {}

    @model_validator(mode="after")
    def _unique_cameras(self) -> "RsmTable":
        numbers = list(self.cameras.values())
        for number in numbers:
            if numbers.count(number) > 1:
                raise ValueError(f"camera number {number} is assigned to more than one camera")
        return self

    # Тип и опасность: правило класса, затем суперкласс, затем умолчание
    def resolve(self, class_name: str, superclass: str) -> tuple[int, int]:
        rule = self.classes.get(class_name, ClassRule())
        danger = rule.danger or self.superclasses.get(superclass, 0) or self.defaults.danger
        return rule.type or self.defaults.type, danger


class Zone(BaseModel):
    number: int = Field(ge=0, le=65535)
    name: str = ""
    color: str = "#94a1ab"
    # Зона вне многоугольников
    default: bool = False


class IskraTable(BaseModel):
    # Класс модели → код 28163; класса нет — только журнал
    codes: dict[str, Code] = {"Человек": 0, "Автомобиль": 3, "Грузовик": 4}
    # id камеры → роль
    roles: dict[str, Role] = {}
    # Порядок — опасность: первая самая опасная
    zones: list[Zone] = [
        Zone(number=1, name="На пути", color="#ff6b80"),
        Zone(number=2, name="Опасная близость", color="#f0bd57"),
        Zone(number=3, name="Полоса отвода", color="#6aa8ff", default=True),
    ]

    @model_validator(mode="after")
    def _valid_zones(self) -> "IskraTable":
        numbers = [z.number for z in self.zones]
        if len(set(numbers)) != len(numbers):
            raise ValueError("zone numbers must be unique")
        if sum(z.default for z in self.zones) != 1:
            raise ValueError("exactly one zone must be the default")
        return self

    def default_zone(self) -> int:
        return next(z.number for z in self.zones if z.default)


class RsmSettings(BaseModel):
    stitch: Stitch = Stitch()
    websocket: WebSocketModule = WebSocketModule()
    can: CanModule = CanModule()
    table: RsmTable = RsmTable()


class IskraSettings(BaseModel):
    stitch: Stitch = Stitch()
    modbus: ModbusModule = ModbusModule()
    table: IskraTable = IskraTable()


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
