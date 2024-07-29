function takeHandler(store, key, port) {
    if (store[key] === undefined) {
        store[key] = { value: null, waitQueue: [] };
    }
    if (store[key].value !== null) {
        var takenValue = store[key].value;
        store[key].value = null;
        port.postMessage(takenValue);
    }
    else {
        store[key].waitQueue.push(port);
    }
}
function giveHandler(store, key, value, port) {
    if (!store[key]) {
        store[key] = { value: null, waitQueue: [] };
    }
    var waiter = store[key].waitQueue.shift();
    if (waiter) {
        waiter.postMessage(value);
    }
    else {
        store[key].value = value;
    }
    port.postMessage(undefined);
}
function eventHandler(store) {
    return function (event) {
        var _a = event.data, action = _a.action, key = _a.key, value = _a.value;
        var port = event.ports[0];
        if (!port) {
            console.error("No `MessagePort` provided to affine event handler");
            return;
        }
        switch (action) {
            case "take":
                takeHandler(store, key, port);
                break;
            case "give":
                giveHandler(store, key, value, port);
                break;
            default:
                console.error("Illegal action `".concat(action, "` provided to affine event handler"));
        }
    };
}
var affineStore = {};
self.addEventListener("message", eventHandler(affineStore));
//# sourceMappingURL=affine-service-worker.js.map