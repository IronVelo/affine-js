// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Asynchronous affine type management for browsers, enforcing the types invariants across tabs.
 * @author IronVelo
 * @version 0.1.0
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
    private sendMsg(action: "take" | "give", value?: T): Promise<T | undefined> {
        if (!this.serviceWorker.active) {
            throw new InactiveServiceWorker();
        }

        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => resolve(event.data);
            
            this.serviceWorker.active.postMessage(
                { action, key: this.key, value },
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

    take(): Promise<T> {
        return this.sendMsg("take").then((response) => Affine.handleTakeRes(response));
    }

    async give(value: T): Promise<void> {
        await this.sendMsg("give", value);
    }
}
