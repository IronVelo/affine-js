// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Affine type management error kinds
 * @author IronVelo
 * @version 0.1.0
 */

export class PreconditionViolated extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AffinePreconditionViolation";
    }
}

export class NoServiceWorkerSupport extends Error {
    constructor() {
        super("Service workers are not supported in the current browser");
        this.name = "NoServiceWorkerSupport";
    }
}

export class ServiceWorkerRegistrationError extends Error {
    constructor(reason: Error) {
        super(`Affine Service Worker registration failed, reason: ${reason}`);
        this.name = "ServiceWrokerRegistrationError";
    }
}

export class InactiveServiceWorker extends Error {
    constructor() {
        super("Affine Service Worker is not active");
        this.name = "InactiveServiceWorker";
    }
}

export class UnexpectedError extends Error {
    constructor(message?: string) {
        super(`Unexpected error encountered in \`Affine\`'s \`take\` invocation: ${message}`);
        this.name = "UnexpectedError";
    }
}
