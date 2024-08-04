// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Affine type browser management\'s service worker.
 * @author IronVelo
 * @version 0.3.0
 */

import { Queue } from './queue';

interface Waiter {
    id: string,
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

function takeHandler(ctx: UbiCtx, client: Client) {
    let node = ctx.store[ctx.key];
    if (node === undefined) {
	    ctx.store[ctx.key] = { value: null, waitQueue: new Queue() };
    }

    if (node.value !== null) {
        const takenValue = node.value;
        node.value = null;
        ctx.port.postMessage(takenValue);
    } else {
        node.waitQueue.enqueue({ id: client.id, port: ctx.port });
    }
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

        let client = await swScope.clients.get(maybe.id);

        // needs review as we are yielding. But, we have ownership of our value. 
        if (client !== undefined) {
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
        ctx.port.postMessage(undefined);
        return;
    }

    // prior to getting a valid waiter, we check if the queue is empty
    if (node.waitQueue.isEmpty()) {
        // fast path, give val immediately.
        node.value = value;

        // exit early
        ctx.port.postMessage(undefined);
        return;
    }

    getValidWaiter(node.waitQueue).then(member => {
        if (member) {
            // we found a valid waiter, immediately provide the value to ensure fairness.
            member.postMessage(value);
        } else {
            // there was no valid waiter, provide ready value.
            node.value = value;
        }
    });

    // we can let the task waiting on us go early, we'll handle the rest.
    ctx.port.postMessage(undefined);
}

function isReadyHandler(ctx: UbiCtx) {
    let node = ctx.store[ctx.key];
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

function numWaitersHandler(ctx: UbiCtx) {
    let node = ctx.store[ctx.key];

    if (!node) {
        ctx.port.postMessage(0);
        return;
    }

    ctx.port.postMessage(node.waitQueue.size());
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
                    takeHandler(ctx, event.source as Client);
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
