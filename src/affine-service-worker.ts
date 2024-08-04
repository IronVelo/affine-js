// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Affine type browser management\'s service worker.
 * @author IronVelo
 * @version 0.2.0
 */

import { Queue } from './queue';

interface AffineData<T> {
    value: T | null,
    waitQueue: Queue<MessagePort>;
}

type AffineStore = { [key: string]: AffineData<unknown> };

interface AffineMsg {
    action: "take" | "give" | "waitCount" | "isReady",
    key: string,
    value?: any
}

function takeHandler(store: AffineStore, key: string, port: MessagePort) {
    if (store[key] === undefined) {
	    store[key] = { value: null, waitQueue: new Queue() };
    }

    if (store[key].value !== null) {
        const takenValue = store[key].value;
        store[key].value = null;
        port.postMessage(takenValue);
    } else {
        store[key].waitQueue.enqueue(port);
    } 
}

function giveHandler(store: AffineStore, key: string, value: any, port: MessagePort) {
    if (!store[key]) {
        store[key] = { value: null, waitQueue: new Queue() };
    }

    const waiter = store[key].waitQueue.dequeue();

    if (waiter) {
        waiter.postMessage(value);
    } else {
        store[key].value = value;
    }

    port.postMessage(undefined);
}

function isReadyHandler(store: AffineStore, key: string, port: MessagePort) {
    console.log("handling is ready request");
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

function numWaitersHandler(store: AffineStore, key: string, port: MessagePort) {
    console.log("handling num waiters request");
    if (!store[key]) {
        console.log("key not found, ret 0");
        port.postMessage(0);
        return;
    }
    console.log("key found, getting count");

    port.postMessage(store[key].waitQueue.size());
}

function eventHandler(store: AffineStore): (event: ExtendableMessageEvent) => void {
    return (event: ExtendableMessageEvent) => {
        const { action, key, value } = event.data as AffineMsg;
        const port = event.ports[0];

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
                    console.error(`Illegal action \`${action}\` provided to affine event handler`);
            }
        } catch (error) {
            console.log(`Encountered error in affine event handler: ${error}`);
        }
    }
}

const affineStore: AffineStore = {};
self.addEventListener("message", eventHandler(affineStore));
