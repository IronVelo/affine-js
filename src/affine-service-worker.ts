// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Affine type browser management\'s service worker.
 * @author IronVelo
 * @version 0.3.0
 */

import { Queue } from './queue';

interface Waiter {
    port: MessagePort
}

interface AffineData<T> {
    value: T | null,
    waitQueue: Queue<Waiter>;
}

type AffineStore = { [key: string]: AffineData<unknown> };

interface AffineMsg {
    action: "take" | "give" | "waitCount" | "isReady",
    key: string,
    value?: any
}

interface UbiCtx {
    store: AffineStore,
    key: string,
    port: MessagePort,
}

function postData(port: MessagePort, data: any) {
    port.postMessage({kind: "d", data: data});
}

function postPing(port: MessagePort) {
    port.postMessage({kind: "l", data: "ping"});
}

function takeHandler(ctx: UbiCtx) {
    let node = ctx.store[ctx.key];
    if (node === undefined) {
        node = { value: null, waitQueue: new Queue() };
    }

    if (node.value !== null) {
        const takenValue = node.value;
        node.value = null;
        postData(ctx.port, takenValue);
    } else {
        node.waitQueue.enqueue({ port: ctx.port });
    }
}

function pingPromise(port: MessagePort): Promise<boolean> {
    return new Promise((resolve) => {
        postPing(port);
        port.onmessage = (event) => { resolve(true); }
    });
}

function ping(port: MessagePort): Promise<boolean> {
    // TODO: relying on time to interpret the port being closed is bad. Moving forward a more robust
    // heuristic should be employed. Before first major release this must not exist.
    // 
    // --- Attempted Solutions ---
    // 
    // - Check if the client ID still is connected.
    //     ISSUE: This does not work when the page is refreshed.
    // - Wrap port in WeakRef to lean on the garbage collector as a heuristic.
    //     ISSUE: This worked half of the time. Was more flaky than the client ID check.
    // - Communicate closed to the service worker with `beforeunload`
    //     ISSUE: Again, this worked sometimes, but not close to always. Which is unacceptable.
    // 
    // I'll be tracking the open issue for adding a way of checking if a message port is open.
    // But, even when this is supported, it will take time for most users to update their browsers,
    // so this will take time.
    // 
    // I'll be working on other hacks to get this more reliable, as again, this solution has many
    // contingencies related to its correctness and can lead to starvation. 
    // 
    // One way to iterate on this poor solution is through a moving average of round trip times. 
    // 
    // Also, in a later version this acknowledgement should be merged with the actual providing of 
    // data to avoid the excess hop (even though the cost of that be minimal, which is why it is 
    // acceptable for v0.3.1.
    let against = new Promise((resolve) => {
        setTimeout(resolve, 300, false)
    });

    return Promise.race([pingPromise(port), against]) as Promise<boolean>;
}

async function getValidWaiter(queue: Queue<Waiter>): Promise<MessagePort | undefined> {
    // rather than pulling all clients, we use the get api. This is to prioritize hot path where generally
    // we will succeed on first iter.
    let swScope = self as any; // ts skill issue
    while (true) {
        let maybe = queue.dequeue();

        if (maybe === undefined) {
            // we have exhausted the queue.
            return undefined;
        }

        let isAlive = await ping(maybe.port);

        if (isAlive) {
            return maybe.port;
        }

        // if we couldn't get it, we continue draining the queue.
    }
}

function giveHandler(ctx: UbiCtx, value: any) {
    let node = ctx.store[ctx.key];
    if (!node) {
        // we must not have any waiters as the store was never initialized for this key.
        ctx.store[ctx.key] = { value, waitQueue: new Queue() };

        // exit early
        postData(ctx.port, undefined);
        return;
    }

    // prior to getting a valid waiter, we check if the queue is empty
    if (node.waitQueue.isEmpty()) {
        // fast path, give val immediately.
        node.value = value;

        // exit early
        postData(ctx.port, undefined);
        return;
    }

    getValidWaiter(node.waitQueue).then(member => {
        if (member) {
            // we found a valid waiter, immediately provide the value to ensure fairness.
            postData(member, value);
        } else {
            // there was no valid waiter, provide ready value.
            node.value = value;
        }
    });

    // we can let the task waiting on us go early, we'll handle the rest.
    postData(ctx.port, undefined);
}

function isReadyHandler(ctx: UbiCtx) {
    let node = ctx.store[ctx.key];
    if (!node) {
        postData(ctx.port, false);
        return;
    }

    if (!node.waitQueue.isEmpty()) {
        postData(ctx.port, false);
        return;
    }

    if (node.value === null) {
        postData(ctx.port, false);
        return;
    }

    postData(ctx.port, true);
}

function numWaitersHandler(ctx: UbiCtx) {
    let node = ctx.store[ctx.key];

    if (!node) {
        postData(ctx.port, 0);
        return;
    }

    postData(ctx.port, node.waitQueue.size());
}

function eventHandler(store: AffineStore): (event: ExtendableMessageEvent) => void {
    return (event: ExtendableMessageEvent) => {
        const { action, key, value } = event.data as AffineMsg;
        const port = event.ports[0];

        if (!port) {
            console.error("No `MessagePort` provided to affine event handler");
            return;
        }

        let ctx: UbiCtx = { port: port, key: key, store: store };

        try {
            switch (action) {
                case "take":
                    takeHandler(ctx);
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
                    console.error(`Illegal action \`${action}\` provided to affine event handler`);
            }
        } catch (error) {
            console.log(`Encountered error in affine event handler: ${error}`);
        }
    }
}

const affineStore: AffineStore = {};
self.addEventListener("message", eventHandler(affineStore));
