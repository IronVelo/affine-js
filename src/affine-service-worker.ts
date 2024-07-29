// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Affine type browser management\'s service worker.
 * @author IronVelo
 * @version 0.1.0
 */

interface AffineData<T> {
    value: T | null,
    waitQueue: MessagePort[];
}

type AffineStore = { [key: string]: AffineData<unknown> };

interface AffineMsg {
    action: "take" | "give",
    key: string,
    value?: any
}

function takeHandler(store: AffineStore, key: string, port: MessagePort) {
    if (store[key] === undefined) {
        store[key] = { value: null, waitQueue: [] };
    }

    if (store[key].value !== null) {
        const takenValue = store[key].value;
        store[key].value = null;
        port.postMessage(takenValue);
    } else {
        store[key].waitQueue.push(port);
    } 
}

function giveHandler(store: AffineStore, key: string, value: any, port: MessagePort) {
    if (!store[key]) {
        store[key] = { value: null, waitQueue: [] };
    }

    const waiter = store[key].waitQueue.shift();

    if (waiter) {
        waiter.postMessage(value);
    } else {
        store[key].value = value;
    }

    port.postMessage(undefined);
}

function eventHandler(store: AffineStore): (event: ExtendableMessageEvent) => void {
    return (event: ExtendableMessageEvent) => {
        const { action, key, value } = event.data as AffineMsg;
        const port = event.ports[0];

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
                console.error(`Illegal action \`${action}\` provided to affine event handler`);
        }
    }
}

const affineStore: AffineStore = {};
self.addEventListener("message", eventHandler(affineStore));
