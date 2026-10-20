import json
import logging
from pathlib import Path
from typing import Annotated, Optional

from pydantic import BaseModel, Field, ValidationError, model_validator

logger = logging.getLogger(__name__)

# Число таблицы соответствий; 0 — пусто, наружу не уходит
Number = Annotated[int, Field(ge=0, le=65535)]
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


class Entry(BaseModel):
    number: int = Field(ge=1, le=65535)
    name: str = ""


def entries(rows: list[tuple[int, str]]) -> list[Entry]:
    return [Entry(number=n, name=name) for n, name in rows]


def check_dictionary(name: str, rows: list[Entry], limit: int) -> None:
    numbers = [e.number for e in rows]
    if len(set(numbers)) != len(numbers):
        raise ValueError(f"dictionary {name}: numbers must be unique")
    if any(n > limit for n in numbers):
        raise ValueError(f"dictionary {name}: numbers must not exceed {limit}")


# Число из словаря протокола; вне словаря — пусто
def known(rows: list[Entry], number: int) -> int:
    return number if any(e.number == number for e in rows) else 0


class ModelTable(BaseModel):
    # id класса → число; строки нет — id + 1
    classes: dict[int, Number] = {}
    # Место суперкласса в списке конфигурации → число; строки нет — место + 1
    superclasses: dict[int, Number] = {}
    # id зоны каталога → число; строки нет — id; 0 — вне зон, без строки пусто
    zones: dict[int, Number] = {}

    def class_no(self, class_id: int) -> int:
        return self.classes.get(class_id, class_id + 1)

    def superclass_no(self, place: int) -> int:
        return self.superclasses.get(place, place + 1)

    def zone_no(self, zone_id: int) -> int:
        return self.zones.get(zone_id, zone_id)


class RsmDictionaries(BaseModel):
    type: list[Entry] = entries([
        (1, "Человек"), (2, "Инструмент"), (3, "Металлический предмет"), (4, "Каменные и бетонные материалы"),
        (5, "Древесные материалы"), (6, "Полимерные и текстильные материалы"), (7, "Сезонные и погодные объекты"),
        (8, "Специфические предметы, связанные с работами РСМ"),
    ])
    danger: list[Entry] = entries([
        (1, "Информация (нет опасности)"), (2, "Средняя опасность"), (3, "Высокая опасность"), (4, "Критическая опасность"),
    ])

    @model_validator(mode="after")
    def _valid(self) -> "RsmDictionaries":
        # Тип и опасность — байты кадра CAN
        check_dictionary("type", self.type, 255)
        check_dictionary("danger", self.danger, 255)
        return self


class RsmTable(BaseModel):
    # Конфигурация нейросети → числа; конфигурации нет — всё по +1
    models: dict[str, ModelTable] = {}
    # Правило РСМ: конфигурация нейросети → id класса → опасность вместо суперкласса
    danger_override: dict[str, dict[int, Number]] = {}
    # id камеры → номер
    cameras: dict[str, CameraNo] = {}

    @model_validator(mode="after")
    def _unique_cameras(self) -> "RsmTable":
        numbers = list(self.cameras.values())
        if len(set(numbers)) != len(numbers):
            raise ValueError("camera numbers must be unique")
        return self


class IskraDictionaries(BaseModel):
    code: list[Entry] = entries([
        (1, "Человек, не удалось распознать наличие СИЗ"), (2, "Человек в СИЗ"), (3, "Человек без СИЗа"),
        (4, "Легковая автомобильная техника"), (5, "Грузовая автомобильная техника"), (6, "Строительная техника"),
        (7, "Сыпучие отходы производства"), (8, "Твёрдые отходы производства"), (9, "Железнодорожная шпала (мусор)"),
        (10, "Граффити"), (11, "Борщевик"),
    ])
    zone: list[Entry] = entries([(1, "На пути"), (2, "Опасная близость"), (3, "Полоса отвода")])

    @model_validator(mode="after")
    def _valid(self) -> "IskraDictionaries":
        check_dictionary("code", self.code, 65535)
        check_dictionary("zone", self.zone, 65535)
        return self


class IskraCamera(BaseModel):
    # Бит маски камер записи 28163
    bit: int = Field(ge=1, le=8)
    name: str = ""
    # Камера технического зрения; пусто — не назначена
    camera_id: str = ""


class IskraTable(BaseModel):
    models: dict[str, ModelTable] = {}
    # Камеры Искры: по умолчанию четыре, не больше восьми
    cameras: list[IskraCamera] = [
        IskraCamera(bit=1, name="Дальняя"), IskraCamera(bit=2, name="Ближняя"),
        IskraCamera(bit=3, name="Левая"), IskraCamera(bit=4, name="Правая"),
    ]

    @model_validator(mode="after")
    def _valid_cameras(self) -> "IskraTable":
        bits = [c.bit for c in self.cameras]
        if len(set(bits)) != len(bits):
            raise ValueError("camera bits must be unique")
        assigned = [c.camera_id for c in self.cameras if c.camera_id]
        if len(set(assigned)) != len(assigned):
            raise ValueError("a vision camera is assigned to more than one camera")
        return self


class RsmSettings(BaseModel):
    stitch: Stitch = Stitch()
    websocket: WebSocketModule = WebSocketModule()
    can: CanModule = CanModule()
    table: RsmTable = RsmTable()
    dictionaries: RsmDictionaries = RsmDictionaries()

    # Тип и опасность CAN: класс → тип; опасность — правило РСМ, иначе суперкласс, без него пусто
    def resolve(self, config_id: str, class_id: int, superclass: str, superclass_id: int) -> tuple[int, int]:
        model = self.table.models.get(config_id, ModelTable())
        override = self.table.danger_override.get(config_id, {})
        if class_id in override:
            danger = override[class_id]
        elif superclass:
            danger = model.superclass_no(superclass_id)
        else:
            danger = 0
        return known(self.dictionaries.type, model.class_no(class_id)), known(self.dictionaries.danger, danger)


class IskraSettings(BaseModel):
    stitch: Stitch = Stitch()
    modbus: ModbusModule = ModbusModule()
    table: IskraTable = IskraTable()
    dictionaries: IskraDictionaries = IskraDictionaries()

    def code(self, config_id: str, class_id: int) -> int:
        return known(self.dictionaries.code, self.table.models.get(config_id, ModelTable()).class_no(class_id))

    def zone(self, config_id: str, zone_id: int) -> int:
        return known(self.dictionaries.zone, self.table.models.get(config_id, ModelTable()).zone_no(zone_id))

    def camera_mask(self, camera_id: str) -> int:
        return sum(1 << (c.bit - 1) for c in self.table.cameras if c.camera_id and c.camera_id == camera_id)


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
