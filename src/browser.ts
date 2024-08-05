// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Asynchronous affine type management for browsers, enforcing the types invariants across tabs.
 * @author IronVelo
 * @version 0.3.0
 */

import {
    NoServiceWorkerSupport,
    ServiceWorkerRegistrationError,
    InactiveServiceWorker,
    UnexpectedError
} from './error';

export default class Affine<T> {
    private key: string;
    private static readonly DEFAULT_SW_PATH = "affine-service-worker.js";
    private serviceWorker: ServiceWorkerRegistration;

    private constructor(key: string, service_worker: ServiceWorkerRegistration) {
        this.key = key;
        this.serviceWorker = service_worker;

        this.sendMsg.bind(this);
        this.take.bind(this);
        this.give.bind(this);
        this.waitCount.bind(this);
        this.isReady.bind(this);
    }

    /**
     * Initialize the affine service worker
     * 
     * @throws {NoServiceWorkerSupport} - Service workers are not supported in the current browser
     * @throws {ServiceWorkerRegistrationError} - There was an unexpected error when initializing the service worker.
     */
    private static async initializeServiceWorker(swPath?: string): Promise<ServiceWorkerRegistration> {
        if (!("serviceWorker" in navigator)) {
            // TODO: fallback impl, even if less robust. Though, 98% of browsers support, practically all modern
            // browsers have support.
            throw new NoServiceWorkerSupport();
        }
        
        const worker = navigator.serviceWorker as ServiceWorkerContainer;

        try {
            const registration = await worker.register(
                swPath || this.DEFAULT_SW_PATH 
            );
            await worker.ready;
            return registration;
        } catch (error) {
            throw new ServiceWorkerRegistrationError(error)    
        }
    }

    /**
     * Get or initialize the `Affine` type.
     *
     * If the `Affine` service worker does not already exist this will create a new one, otherwise it will use the 
     * existing service worker.
     *
     * @param key - The identifier for the affine type, used for storage and management of the value. Think of this as
     *  a global variable identifier.
     *
     * @throws {NoServiceWorkerSupport} - Service workers are not supported in the current browser. Note: Service 
     *  worker support is fairly ubiquitous nowadays, despite this, in a future release we will add a fallback.
     * @throws {ServiceWorkerRegistrationError} - If the service worker did not already exist, and there was an error 
     *  on initialization, this will be thrown with the reason for the failure.
     */
    static init<T>(key: string, swPath?: string): Promise<Affine<T>> {
        return Affine.initializeServiceWorker(swPath)
            .then((registration) => new Affine<T>(key, registration));
    }

    /**
     * Send a message to the affine service worker
     *
     * @throws {InactiveServiceWorker} - The service worker could not accept a message
     */
    private sendMsg<R>(action: "take" | "give" | "isReady" | "waitCount", value?: T): Promise<R | undefined> {
        if (!this.serviceWorker.active) {
            throw new InactiveServiceWorker();
        }

        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => {
                if (event.data) {
                switch (event.data.kind) {
                    case "l": // liveness check
                        channel.port1.postMessage("pong");
                        break;
                    case "d": // data recv
                        resolve(event.data.data);
                        break;
                    default:
                        // this should be unreachable.
                        console.error(
                            `Impossibility encountered, illegal event kind from service worker: ${event.data.kind}`
                        );
                        reject();
                        break;
                }}
            }
            
            this.serviceWorker.active.postMessage(
                { action, key: this.key, value: value },
                [channel.port2]
            );
        });
    }

    private static handleTakeRes<T>(response: T | undefined): T {
        if (response === undefined) {
            throw new UnexpectedError("response was undefined");
        }
        return response;
    }

    /**
     * Take the value, either immediately being resolved as there was already a ready value and no waiters, or
     * be added to the wait queue, to be resolved when a value becomes ready.
     */
    take(): Promise<T> {
        return this.sendMsg<T>("take").then((response) => Affine.handleTakeRes(response));
    }

    /**
     * Give the value to the affine type, either waking the next waiter or leaving the value for the next `take` 
     * invocation.
     */
    async give(value: T): Promise<void> {
        await this.sendMsg("give", value);
    }

    /**
     * Get the number of tasks currently waiting on the affine type's value.
     *
     * @returns {Promise<number>} The number of tasks currently waiting.
     */
    waitCount(): Promise<number> {
        return this.sendMsg<number>("waitCount");
    }

    /**
     * Check if there is currently a ready value (meaning the next request will be immediately resolved). Of course, 
     * this does not imply that this thread is the one which will be immediately resolved, as no separate operations 
     * are to be considered atomic.
     *
     * @returns {Promise<boolean>} if the affine type currently holds a value and nothing is waiting on said value.
     */
    isReady(): Promise<boolean> {
        return this.sendMsg<boolean>("isReady");
    }
}
