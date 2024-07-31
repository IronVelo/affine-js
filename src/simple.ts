// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * @file Asynchronous affine type management for local/simple environments.
 * @author IronVelo
 * @version 0.1.0
 */

import { PreconditionViolated } from './error';
import { Queue } from './queue';

export default class Affine<T> {
    private readyValue: T | null = null;
    private waitQueue: Queue<(value: T) => void> = new Queue();

    constructor() {
        this.take.bind(this);
        this.give.bind(this);
        this.create_waiter.bind(this);
        this.ready_value.bind(this);
        this.give_ready.bind(this);
    }

    /**
     * **Precondition**: `this.readyValue` must be null.
     * **Postcondition**: As long as `this.give` is eventually invoked the returned promise will eventually resolve.
     *
     * If the precondition is not respected fairness will be violated.
     *
     * @throws {PreconditionViolated} - Precondition was violated.
     */
    private create_waiter(): Promise<T> {
        if (this.readyValue !== null) {
            throw new PreconditionViolated(
                "Precondition violated for creating waiter, this will violate fairness and possibly lead to \
                 starvation. This is a bug within `Affine<T>`"
            );
        }

        return new Promise((resolve) => this.waitQueue.enqueue(resolve));
    }

    /**
     * **Precondition**: `this.readyValue` must not be null.
     * **Postcondition**: The returned promise is immediately ready and the associated value is non-null.
     *
     * @throws {PreconditionViolated} - Precondition was violated.
     */
    private ready_value(): Promise<T> {
        let ready = this.readyValue;
        this.readyValue = null;

        if (ready === null) {
            throw new PreconditionViolated(
                "Precondition violated for claiming ready_value, this is an impossibility and a bug within `Affine<T>`"
            );
        }

        return new Promise((resolve) => resolve(ready));
    }

    /**
     * Take the value `T` once it exists.
     */
    take(): Promise<T> {
        if (this.readyValue !== null) {
            return this.ready_value();
        } else {
            return this.create_waiter();
        }
    }

    /**
     * **Precondition**: `this.readyValue` must be null /\ `this.waitQueue` must be empty.
     * **Postcondition**: `this.readyValue` will be set to `value`, available immediately for the next `take`
     *   invocation.
     *
     * @throws {PreconditionViolated} - Precondition was violated.
     */
    private give_ready(value: T) {
        if (this.waitQueue.isEmpty() && this.readyValue === null) {
            this.readyValue = value;
        } else {
            throw new PreconditionViolated(
                "Precondition violated for providing a ready value. The wait queue must be empty and the `readyValue` \
                must be null. This is a bun within `Affine<T>`"
            );
        }
    }

    // CONSIDERATION: Should this return ready promises enabling simplistic swapping between the local and browser
    // variants?
    /**
     * Provide the value `T` to the next task waiting on `take` if one exists, otherwise provide to the next request
     * for the value.
     */
    give(value: T) {
        let waiter = this.waitQueue.dequeue();

        if (waiter === undefined) {
            // Nothing is waiting on our data, so we store in our readyValue
            this.give_ready(value);
        } else {
            // Resolve the waiter providing it the value, ensuring fairness/preventing starvation.
            waiter(value);
        }
    }
}
