import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Target(Model):
    name: str = Field(default='Стенд .102', max_length=80)
    api: str = 'http://127.0.0.1:8000'
    frontend: str = 'http://127.0.0.1'
    mc: str = 'http://127.0.0.1:7777'
    gateway: str = 'http://127.0.0.1:9090'
    gateway_grpc: str = Field(default='127.0.0.1:50051', pattern=r'^[a-zA-Z0-9._-]+:[0-9]{1,5}$')
    detection: str = 'http://127.0.0.1:8003'
    storage: str = 'http://127.0.0.1:8001'
    ssh_host: str = '127.0.0.1'
    ssh_port: int = Field(default=22, ge=1, le=65535)
    ssh_user: str = Field(default='orangepi', pattern=r'^[a-zA-Z0-9_.-]{1,64}$')
    ssh_fingerprint: str = Field(default='', max_length=100)
    sudo: bool = False
    binary: str = '/home/orangepi/media-center-vscode/build/media-center'
    cwd: str = '/home/orangepi/media-center-vscode/build'
    argv: list[str] = Field(default_factory=lambda: ['--rest-port=7777', '--signaling-ip=127.0.0.1', '--signaling-port=8765', '--varan-root=/home/orangepi/varan', '--archive-dir=/storage/archive', '--modules=birdview,neural', '--gateway-ip=127.0.0.1', '--gateway-port=50051', '--detection-ip=127.0.0.1', '--detection-port=50052'])
    env: dict[str, str] = Field(default_factory=lambda: {'DISPLAY': ':0', 'XAUTHORITY': '/home/orangepi/.Xauthority', 'XDG_RUNTIME_DIR': '/run/user/1000'})
    gst_env: str = '/opt/gstreamer-1.28/env.sh'
    archive: str = '/storage/archive'
    varan: str = '/home/orangepi/varan'
    public_host: str = '192.168.1.102'
    reserve_gib: float = Field(default=4, ge=4, le=1024)
    trace_mb: int = Field(default=100, ge=1, le=2048)
    data_reserve_mb: int = Field(default=512, ge=256, le=65536)

    @field_validator('api', 'frontend', 'mc', 'gateway', 'detection', 'storage')
    @classmethod
    def address(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('An HTTP URL without credentials is required')
        return value.rstrip('/')

    @field_validator('binary', 'cwd', 'archive', 'varan', 'gst_env')
    @classmethod
    def absolute(cls, value):
        if not value.startswith('/') or '\x00' in value or '..' in value.split('/'):
            raise ValueError('An absolute host path is required')
        return value

    @field_validator('ssh_host', 'public_host')
    @classmethod
    def hostname(cls, value):
        if not re.fullmatch(r'[a-zA-Z0-9.:_-]{1,253}', value):
            raise ValueError('Invalid hostname')
        return value


class Emulation(Model):
    protocols: list[Literal['can', 'modbus', 'ws']] = Field(default_factory=lambda: ['can', 'modbus', 'ws'], min_length=1, max_length=3)
    can_line: Literal['software', 'physical'] = 'software'
    can_iface: str = Field(default='rjdtest0', pattern=r'^[a-zA-Z0-9_-]{1,15}$')
    gateway_can_iface: str = Field(default='can1', pattern=r'^[a-zA-Z0-9_-]{1,15}$')
    modbus_line: Literal['software', 'physical'] = 'software'
    serial: str = Field(default='/dev/ttyUSB0', pattern=r'^/dev/[a-zA-Z0-9_./-]{1,100}$')
    gateway_serial: str = Field(default='/dev/ttyUSB1', pattern=r'^/dev/[a-zA-Z0-9_./-]{1,100}$')
    baud: Literal[9600, 19200, 38400, 57600, 115200] = 115200
    slave: int = Field(default=20, ge=1, le=247)
    period_ms: int = Field(default=500, ge=100, le=10000)
    speed_kmh: float = Field(default=40, ge=0, le=250)
    lat: float = Field(default=55.752057, ge=-90, le=90)
    lon: float = Field(default=37.626105, ge=-180, le=180)
    auto_ack: bool = False
    ws_port: int = Field(default=8785, ge=1024, le=65535)
    ws_mode: Literal['receive', 'disconnect', 'slow'] = 'receive'
    fault_seconds: int = Field(default=30, ge=5, le=600)

    @field_validator('protocols')
    @classmethod
    def unique(cls, value):
        return list(dict.fromkeys(value))


class RunOptions(Model):
    cases: list[str] = Field(default_factory=lambda: ['services', 'cameras', 'recording', 'neural', 'surround', 'can', 'modbus', 'ws', 'e2e', 'faults'], min_length=1, max_length=10)
    minutes: int = Field(default=60, ge=1, le=480)
    parallel: int = Field(default=4, ge=1, le=16)
    repeats: int = Field(default=120, ge=1, le=10000)
    slot_repeats: int = Field(default=2, ge=1, le=20)
    scenario: str | None = None
    restarts: list[Literal['mc', 'frontend', 'fastapi', 'detection-service', 'message-gateway', 'storage-service', 'signaling-server', 'camera-scanner']] = Field(default_factory=lambda: ['mc', 'frontend', 'fastapi', 'detection-service', 'message-gateway', 'storage-service', 'signaling-server', 'camera-scanner'])
    emulation: Emulation = Field(default_factory=Emulation)


class Expectation(Model):
    start: float = Field(ge=0, le=86400)
    end: float = Field(ge=0, le=86400)
    fields: dict[str, str | int | float] = Field(min_length=1)
    minimum: int = Field(default=1, ge=0, le=10000)
    maximum: int = Field(default=1, ge=0, le=10000)
    channel: Literal['journal', 'can', 'modbus', 'ws'] = 'journal'


class Scenario(Model):
    name: str = Field(min_length=1, max_length=100)
    model_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    config_id: str = Field(min_length=1, max_length=100)
    camera_id: str = Field(min_length=1, max_length=100)
    duration: float = Field(gt=0, le=3600)
    expectations: list[Expectation] = Field(min_length=1, max_length=1000)
