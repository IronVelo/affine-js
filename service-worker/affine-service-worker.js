(function () {
    'use strict';

    /******************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */
    /* global Reflect, Promise, SuppressedError, Symbol */


    function __awaiter(thisArg, _arguments, P, generator) {
        function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
        return new (P || (P = Promise))(function (resolve, reject) {
            function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
            function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
            function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
            step((generator = generator.apply(thisArg, _arguments || [])).next());
        });
    }

    function __generator(thisArg, body) {
        var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
        return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
        function verb(n) { return function (v) { return step([n, v]); }; }
        function step(op) {
            if (f) throw new TypeError("Generator is already executing.");
            while (g && (g = 0, op[0] && (_ = 0)), _) try {
                if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
                if (y = 0, t) op = [op[0] & 2, t.value];
                switch (op[0]) {
                    case 0: case 1: t = op; break;
                    case 4: _.label++; return { value: op[1], done: false };
                    case 5: _.label++; y = op[1]; op = [0]; continue;
                    case 7: op = _.ops.pop(); _.trys.pop(); continue;
                    default:
                        if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                        if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                        if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                        if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                        if (t[2]) _.ops.pop();
                        _.trys.pop(); continue;
                }
                op = body.call(thisArg, _);
            } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
            if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
        }
    }

    typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
    };

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

    function takeHandler(ctx, client) {
        var node = ctx.store[ctx.key];
        if (node === undefined) {
            ctx.store[ctx.key] = { value: null, waitQueue: new Queue() };
        }
        if (node.value !== null) {
            var takenValue = node.value;
            node.value = null;
            ctx.port.postMessage(takenValue);
        }
        else {
            node.waitQueue.enqueue({ id: client.id, port: ctx.port });
        }
    }
    function getValidWaiter(queue) {
        return __awaiter(this, void 0, void 0, function () {
            var swScope, maybe, client;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        swScope = self;
                        _a.label = 1;
                    case 1:
                        maybe = queue.dequeue();
                        if (maybe === undefined) {
                            return [2, undefined];
                        }
                        return [4, swScope.clients.get(maybe.id)];
                    case 2:
                        client = _a.sent();
                        if (client !== undefined) {
                            return [2, maybe.port];
                        }
                        return [3, 1];
                    case 3: return [2];
                }
            });
        });
    }
    function giveHandler(ctx, value) {
        var node = ctx.store[ctx.key];
        if (!node) {
            ctx.store[ctx.key] = { value: value, waitQueue: new Queue() };
            ctx.port.postMessage(undefined);
            return;
        }
        if (node.waitQueue.isEmpty()) {
            node.value = value;
            ctx.port.postMessage(undefined);
            return;
        }
        getValidWaiter(node.waitQueue).then(function (member) {
            if (member) {
                member.postMessage(value);
            }
            else {
                node.value = value;
            }
        });
        ctx.port.postMessage(undefined);
    }
    function isReadyHandler(ctx) {
        var node = ctx.store[ctx.key];
        if (!node) {
            ctx.port.postMessage(false);
            return;
        }
        if (!node.waitQueue.isEmpty()) {
            ctx.port.postMessage(false);
            return;
        }
        if (node.value === null) {
            ctx.port.postMessage(false);
            return;
        }
        ctx.port.postMessage(true);
    }
    function numWaitersHandler(ctx) {
        var node = ctx.store[ctx.key];
        if (!node) {
            ctx.port.postMessage(0);
            return;
        }
        ctx.port.postMessage(node.waitQueue.size());
    }
    function eventHandler(store) {
        return function (event) {
            var _a = event.data, action = _a.action, key = _a.key, value = _a.value;
            var port = event.ports[0];
            if (!port) {
                console.error("No `MessagePort` provided to affine event handler");
                return;
            }
            var ctx = { port: port, key: key, store: store };
            try {
                switch (action) {
                    case "take":
                        takeHandler(ctx, event.source);
                        break;
                    case "give":
                        giveHandler(ctx, value);
                        break;
                    case "waitCount":
                        numWaitersHandler(ctx);
                        break;
                    case "isReady":
                        isReadyHandler(ctx);
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
