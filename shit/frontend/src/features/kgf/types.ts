export type PeripheralState = 'stopped' | 'starting' | 'running' | 'error' | string;

export interface PeripheralRuntime {
    transition_id: string;
    state: string;
    revision: string;
    modules: string[];
    restored?: boolean;
    updated_at?: string | null;
}

export interface GatewayTime {
    unix_ms: number;
    lat: number;
    lon: number;
    alt: number;
    gps_valid: boolean;
    tz_offset_min: number;
    can_time: boolean;
    ntp_time: boolean;
    trip: boolean | null;
    updated_at: string | null;
}

export interface PeripheralChannel {
    id: string;
    name: string;
    unit: string;
    type: 'number' | 'boolean' | 'array' | 'scan' | string;
    frequency_hz: number;
}

export interface PeripheralDevice {
    id: string;
    kind: string;
    name: string;
    state: PeripheralState;
    message: string | null;
    channels: PeripheralChannel[];
    diagnostics?: {
        started_at?: string | null;
        last_success_at?: string | null;
        last_error_at?: string | null;
        success_count?: number;
        error_count?: number;
        consecutive_errors?: number;
        reconnect_count?: number;
        observed_hz?: number;
        transport?: {
            type?: string;
            port?: string | number | null;
            host?: string;
            protocol?: string;
            adapter_present?: boolean;
            port_open?: boolean;
            baudrate?: number;
            format?: string;
            slave_id?: number | null;
        };
        channels?: Record<string, {
            last_value_at?: string | null;
            age_ms?: number | null;
            sequence?: number | null;
            state?: 'fresh' | 'stale' | 'no_data' | string;
        }>;
    };
}

export interface PeripheralValue {
    device_id: string;
    channel_id: string;
    value: number | boolean | string | number[] | Record<string, unknown> | null;
    captured_at: string;
    sequence: number;
}

export interface PeripheralStatus {
    service: string;
    runtime: PeripheralRuntime;
    gateway_time: GatewayTime;
    devices: PeripheralDevice[];
}

export interface PeripheralSnapshot {
    status: PeripheralStatus;
    values: PeripheralValue[];
}
