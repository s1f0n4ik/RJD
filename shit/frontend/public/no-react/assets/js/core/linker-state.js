/**
 * linker/state.js — Состояние модуля линкера
 */
'use strict';

export const linkerState = {
    exports:        [],     // [{id, name, cameras:[key,...]}]
    cameras:        [],     // только type=3, [{id, display_name}]
    selectedExport: null,   // {id, name, cameras:[...]}
    bindings:       {},     // { [key]: camera_id }
    streaming:      false,
    streamId:       null,   // приходит от /linker/start
};