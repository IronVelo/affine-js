(function () {
    'use strict';

    var Queue = (function () {
        function Queue() {
            this.items = [];
            this.head = 0;
            this.tail = 0;
        }
        Queue.prototype.enqueue = function (element) {
            this.items[this.tail] = element;
            this.tail++;
        };
        Queue.prototype.dequeue = function () {
            if (this.isEmpty()) {
                return undefined;
            }
            var item = this.items[this.head];
            this.head++;
            if (this.head === this.tail) {
                this.clear();
            }
            return item;
        };
        Queue.prototype.peek = function () {
            if (this.isEmpty()) {
                return undefined;
            }
            return this.items[this.head];
        };
        Queue.prototype.isEmpty = function () {
            return this.head === this.tail;
        };
        Queue.prototype.size = function () {
            return this.tail - this.head;
        };
        Queue.prototype.clear = function () {
            this.items = [];
            this.head = 0;
            this.tail = 0;
        };
        return Queue;
    }());

    function takeHandler(store, key, port) {
        if (store[key] === undefined) {
            store[key] = { value: null, waitQueue: new Queue() };
        }
        if (store[key].value !== null) {
            var takenValue = store[key].value;
            store[key].value = null;
            port.postMessage(takenValue);
        }
        else {
            store[key].waitQueue.enqueue(port);
        }
    }
    function giveHandler(store, key, value, port) {
        if (!store[key]) {
            store[key] = { value: null, waitQueue: new Queue() };
        }
        var waiter = store[key].waitQueue.dequeue();
        if (waiter) {
            waiter.postMessage(value);
        }
        else {
            store[key].value = value;
        }
        port.postMessage(undefined);
    }
    function isReadyHandler(store, key, port) {
        if (!store[key]) {
            port.postMessage(false);
            return;
        }
        if (!store[key].waitQueue.isEmpty()) {
            port.postMessage(false);
            return;
        }
        if (store[key].value === null) {
            port.postMessage(false);
            return;
        }
        port.postMessage(true);
    }
    function numWaitersHandler(store, key, port) {
        if (!store[key]) {
            port.postMessage(0);
            return;
        }
        port.postMessage(store[key].waitQueue.size());
    }
    function eventHandler(store) {
        return function (event) {
            var _a = event.data, action = _a.action, key = _a.key, value = _a.value;
            var port = event.ports[0];
            if (!port) {
                console.error("No `MessagePort` provided to affine event handler");
                return;
            }
            try {
                switch (action) {
                    case "take":
                        takeHandler(store, key, port);
                        break;
                    case "give":
                        giveHandler(store, key, value, port);
                        break;
                    case "waitCount":
                        numWaitersHandler(store, key, port);
                        break;
                    case "isReady":
                        isReadyHandler(store, key, port);
                        break;
                    default:
                        console.error("Illegal action `".concat(action, "` provided to affine event handler"));
                }
            }
            catch (error) {
                console.log("Encountered error in affine event handler: ".concat(error));
            }
        };
    }
    var affineStore = {};
    self.addEventListener("message", eventHandler(affineStore));

})();
//# sourceMappingURL=affine-service-worker.js.map
