// Run with: node --test tests/test_ui.js
// Exercise the browser controller against server states, without timers inventing progress.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../static/js/script.js'), 'utf8');

function controller(responses) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, {value: 'auto', style: {}, textContent: '', disabled: false, attributes: {},
            classList: {add() {}, remove() {}, toggle() {}}, setAttribute(key, value) {this.attributes[key] = value;}});
        return elements.get(id);
    }
    const redirects = [];
    const storage = new Map();
    const context = vm.createContext({
        document: {getElementById: element, querySelectorAll: () => [], addEventListener() {}},
        window: {location: {assign: url => redirects.push(url)}},
        sessionStorage: {setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
        setTimeout: callback => callback(),
        fetch: async () => {
            const response = responses.shift();
            if (response instanceof Error) throw response;
            assert.ok(response, 'Controller should not keep polling beyond a terminal status');
            return {ok: response.httpStatus == null || response.httpStatus < 400, status: response.httpStatus || 200, json: async () => response};
        },
    });
    vm.runInContext(script, context);
    return {context, elements, redirects, storage};
}
function submit(context) {
    return vm.runInContext("startAnalysis('text', {set() {}})", context);
}

test('redirects only after server completion, using server result id', async () => {
    const harness = controller([{success: true, task_id: 'job'}, {status: 'processing', stage: 'extract', progress: 37, completed_units: 4, total_units: 10}, {status: 'completed', result_id: 'saved-result', progress: 100}]);
    await submit(harness.context);
    assert.deepEqual(harness.redirects, ['/result/saved-result']);
    assert.equal(harness.elements.get('analysisProgress').attributes['aria-valuenow'], '100');
    assert.equal(harness.storage.size, 0);
});

test('failed server task stays on page and reports error', async () => {
    const harness = controller([{success: true, task_id: 'job'}, {status: 'failed', progress: 23, error: '<b>Model unavailable</b>'}]);
    await submit(harness.context);
    assert.equal(harness.redirects.length, 0);
    assert.equal(harness.elements.get('progressError').textContent, '<b>Model unavailable</b>');
    assert.equal(vm.runInContext('activeTaskId', harness.context), null);
    assert.equal(harness.elements.get('analysisMode').disabled, false);
});

test('network interruption preserves task for explicit reconnect without fake completion', async () => {
    const harness = controller([{success: true, task_id: 'job'}, {status: 'processing', progress: 41}, new Error('Offline')]);
    await submit(harness.context);
    assert.equal(harness.redirects.length, 0);
    assert.equal(harness.elements.get('analysisProgress').attributes['aria-valuenow'], '41');
    assert.equal(vm.runInContext('activeTaskId', harness.context), 'job');
    assert.match(harness.elements.get('progressError').textContent, /重新连接/);
    assert.equal(harness.storage.size, 1);
});

test('missing tasks clear stale saved id and permit a new submission', async () => {
    const harness = controller([{success: true, task_id: 'job'}, {httpStatus: 404, error: 'Task unavailable'}]);
    await submit(harness.context);
    assert.equal(harness.redirects.length, 0);
    assert.equal(vm.runInContext('activeTaskId', harness.context), null);
    assert.equal(harness.storage.size, 0);
    assert.equal(harness.elements.get('analysisMode').disabled, false);
});
