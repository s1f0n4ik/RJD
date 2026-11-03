const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function devicesFixture() {
    const pending = [];
    const modules = new Map();
    const load = file => {
        if (modules.has(file)) return modules.get(file);
        const exports = {};
        modules.set(file, exports);
        const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        vm.runInNewContext(source, {
            exports,
            require: name => load(path.resolve(path.dirname(file), name + '.ts')),
            fetch: () => new Promise(resolve => pending.push(resolve)),
            Error,
        }, { filename: file });
        return exports;
    };
    const devices = load(path.resolve(__dirname, '../src/services/devices.ts'));
    const reply = (index, value, status = 200) => pending[index](new Response(JSON.stringify(value), { status }));
    return { devices, reply };
}

const snapshot = (name, route = name) => ({
    devices: [{ id: 'board', name, ip: '192.0.2.1', modules: [], status: 'online', telemetry: null, last_seen: 1 }],
    routing: { cameras: route, neural: null, birdview: null, krsps: null },
});

(async () => {
    {
        const { devices, reply } = devicesFixture();
        const old = devices.loadDevices();
        const fresh = devices.loadDevices();
        reply(1, snapshot('fresh'));
        await fresh;
        const reference = devices.getDevices();
        reply(0, snapshot('old'));
        await old;
        assert.equal(devices.getDevices(), reference);
        assert.equal(devices.getDevices()[0].name, 'fresh');
        assert.equal(devices.getRouting().cameras, 'fresh');
        const unchanged = devices.loadDevices();
        const reordered = snapshot('fresh');
        reordered.devices[0] = Object.fromEntries(Object.entries(reordered.devices[0]).reverse());
        reply(2, reordered);
        await unchanged;
        assert.equal(devices.getDevices(), reference, 'Identical JSON must preserve the cached snapshot');
        const failed = devices.loadDevices();
        reply(3, { detail: 'Temporary failure' }, 503);
        await assert.rejects(failed, /503/);
        assert.equal(devices.getDevices(), reference, 'Failed polling must preserve loaded devices');
    }
    {
        const { devices, reply } = devicesFixture();
        const initial = devices.loadDevices();
        reply(0, snapshot('initial'));
        await initial;
        const old = devices.loadDevices();
        const poll = devices.devicesApi.poll('board');
        reply(2, { device: snapshot('polled').devices[0] });
        await poll;
        reply(1, snapshot('old'));
        await old;
        assert.equal(devices.getDevices()[0].name, 'polled', 'Late list must not undo an explicit device poll');
        assert.equal(devices.getRouting().cameras, 'initial');
    }
    console.log('polling-check: stale list, manual poll, unchanged snapshot and failed request passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
