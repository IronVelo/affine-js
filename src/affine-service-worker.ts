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
    waitQueue: Queue<Waiter>,
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

function emptyNode<T>(): AffineData<T> {
    return {
        value: null,
        waitQueue: new Queue(),
    }
}

function postData(port: MessagePort, data: any) {
    port.postMessage({kind: "d", data: data});
}

function postPing(port: MessagePort) {
    port.postMessage({kind: "l", data: "ping"});
}

function takeVal(ctx: UbiCtx): any {
    const val = ctx.store[ctx.key].value;
    ctx.store[ctx.key].value = null;
    return val;
}

function takeHandler(ctx: UbiCtx) {
    if (ctx.store[ctx.key] === undefined) {
        ctx.store[ctx.key] = emptyNode();
    }

    const value = takeVal(ctx);

    if (value) {
        postData(ctx.port, value);
    } else {
        ctx.store[ctx.key].waitQueue.enqueue({ port: ctx.port });
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

function newNode<T>(value: T): AffineData<T> {
    let node = emptyNode();
    node.value = value;
    return node as AffineData<T>;
}

/**
 * Precondition:
 * - Node must be undefined/null
 * 
 * Postcondition:
 * - Node will be defined with an empty queue and the provided `value` ready for the next request.
 */
function setNewNode(ctx: UbiCtx, value: any): void {
    if (ctx.store[ctx.key]) {
        console.warn("Precondition violated, attempted to assign new node to a new which already existed.");
        return;
    }

    ctx.store[ctx.key] = newNode(value);

    return;
}

/**
 * Preconditions:
 * - The nodes wait queue must be empty to ensure fairness.
 * - The nodes value must be null.
 *
 * Postcondition:
 * - The next request for a value from this node will be provided the current value.
 *
 * Unchecked Precondition:
 * - The node must not be null/undefined.
 */
function setReadyValue(ctx: UbiCtx, value: any): void {
    let node = ctx.store[ctx.key]
    if (!node.waitQueue.isEmpty()) {
        console.warn(
            "Precondition violated, attempted to provide new node when the wait queue was not empty. \
             This violates the property of fairness and can lead to starvation in extreme circumstances."
        );
        return;
    }

    if (node.value) {
        console.warn(
            "Precondition violated, attempted to assign ready value to a node which already has a ready value. \
             This indicates a violation of the affine types invariants."
        );
        return;
    }

    node.value = value;
    return;
}

/**
 * Precondition:
 * - The waitQueue must be non-empty.
 *
 * Postcondition:
 * - result <-> value provided to waiter.
 *
 * Unchecked Precondition:
 * - The node must not be null/undefined/
 */
function provideValue(ctx: UbiCtx, value: any): Promise<boolean> {
    let node = ctx.store[ctx.key];

    if (node.waitQueue.isEmpty()) {
        console.warn(
            "Precondition violated, attempted to provide value to a waiter but there were no waiters. This \
             should have been provided as the ready value."
        );
        return Promise.resolve(false);
    }

    return getValidWaiter(node.waitQueue).then(member => {
        if (member) {
            postData(member, value);
            return true;
        }
        
        // Since `getValidWaiter` is asynchronous we cannot provide a ready value while maintaining 
        // correctness. We must retry as our state may have changed.
        return false;
    });
}

async function giveImpl(ctx: UbiCtx, value: any): Promise<void> {
    let node = ctx.store[ctx.key];
        
    if (!node) {
        setNewNode(ctx, value);
        return;
    }

    while (true) {
        if (node.waitQueue.isEmpty()) {
            setReadyValue(ctx, value);
            return;
        }

        if (await provideValue(ctx, value)) {
            return;
        }

        // In context change in the async provideValue we ran out of waiters. We cannot know
        // that it is sound to provide a ready value as the state could have been altered in said 
        // context change. 
        // 
        // Continue to base case of checking if the waitQueue is empty synchronously prior to setting
        // ready value. 
    }
}

function giveHandler(ctx: UbiCtx, value: any): Promise<void> {
    return giveImpl(ctx, value).then(() => postData(ctx.port, undefined));
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
                    event.waitUntil(giveHandler(ctx, value));
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
