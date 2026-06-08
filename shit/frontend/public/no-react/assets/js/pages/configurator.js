'use strict';

import { initConfCanvas }   from '../components/configurator/canvas.js';
import { initConfInteract } from '../components/configurator/interact.js';
import { confUpdateField }  from '../components/configurator/field.js';
import { confAddCamera }    from '../components/configurator/cameras.js';
import { confAddZone, confToggleFixedZone, confUpdateFixedZone } from '../components/configurator/zones.js';
import { confAddImage, confOnImageFile } from '../components/configurator/images.js';
import { confTogglePanel, confSelectTool, renderAllLists } from '../components/configurator/panel.js';
import { confOpenExport, confCloseExport, confUpdateExportPreview, confSaveExport } from '../components/configurator/export.js';

export function initConfiguratorPage() {
    initConfCanvas();
    initConfInteract();
    confUpdateField();
    renderAllLists();
}

Object.assign(window, {
    confUpdateField,
    confAddCamera,
    confAddZone,
    confAddImage,
    confOnImageFile,
    confTogglePanel,
    confSelectTool,
    confToggleFixedZone,
    confUpdateFixedZone,
    confOpenExport,
    confCloseExport,
    confUpdateExportPreview,
    confSaveExport,
});