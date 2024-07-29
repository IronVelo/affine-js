# Affine Type Management

A simple, asynchronous affine type implementation for browsers and local contexts. It ensures that an item can only be 
taken once and given once, preventing accidental replays. Designed for token rotation protocols in IdPs, it manages 
token usage across tabs and ensures valid tokens for each request.

## Installation

```sh
npm install affine-ty
```

## Usage

### Browser Context

```js
import { browser } from 'affine-ty';

// Initialize Affine
browser.Affine.init('myKey')
  .then(affine => {
    // Give a value
    affine.give('A Value')
      .then(() => console.log('Value stored'));

    // Take a value
    affine.take()
      .then(value => console.log('Retrieved value: ', value)); // Retrieved value: A Value
  })
  .catch(error => console.error('Error:', error));
```

### Local Context

```js
import { simple } from 'affine-ty';

const affine = new simple.Affine();

// Give a value
affine.give('A Value');

// Take a value
affine.take()
  .then(value => console.log('Retrieved value: ', value)); // Retrieved value: A Value
```

## Browser vs Local Context

The local context can be ran everywhere, but it does not have any ability to communicate across open tabs in the 
user's browser. The browser implementation leverages a service worker to manage the state globally. This greatly
simplifies usage of fundamentally affine types, such as rotation protocols, ensuring that you're free of accidental 
race-conditions where you replay the token signing the user out.

## Important Considerations

As with any synchronization primitive, there are footguns. For example:

```js
let value = await affine.take(); // success
let deadlock = await affine.take(); // deadlock
```

This is the classic deadlock, something which all synchronization primtives are susceptible to. The reason this 
deadlocks is that the second `take` is waiting for the next `give`, but the next `give` will never take place as 
in the current task we own the value. 

So, just never do this, very simple to avoid. Keep the critical section as minimal as possible so that you can easily
reason about the correctness of your program. For example, if I need to make a request with the value I would make sure
to keep the critical section start at the line above the request, and end as soon as the request completes, as follows:

```js
let value = await affine.take();
let res = await fetch("example.com/needs-value", {
    method: 'POST',
    body: JSON.stringify({required: value})
});
await affine.give(res.headers.get('my-affine-value'));
```

It is very easy to reason about the correctness of our usage here, we can very clearly see that we have no potential
for a deadlock.

## Browser Setup

The `browser` Affine type requires the `affine-service-worker.js` file to be distributed by your backend. We are 
unable to distribute this via any CDN for security purposes. The service worker `src/affine-service-worker.ts` is 75 
LOC (lines of code) in total, so it is very easy to review and ensure we are not running anything malicious on your 
behalf.

The default path that the library expects the service worker to exist at is `/affine-service-worker.js`. This can be 
modified via the `swPath` parameter in the `Affine.init` constructor.

You can find the JavaScript for the service worker in the `service-worker` directory. Simply copy this to the directory 
which your server is distributing (for example, on `Next.js` this is your `public` directory).

### Service Worker Install

1. **Move to the directory your server is distributing:**

    ```sh
    cd distributed-directory
    ```

2. **Download the service worker and the corresponding js.map file:**

    ```sh
    wget https://raw.githubusercontent.com/IronVelo/affine-js/main/service-worker/affine-service-worker.js \
        && wget https://raw.githubusercontent.com/IronVelo/affine-js/main/service-worker/affine-service-worker.js.map
    ```

And you're all set up! You now can use the `browser` Affine type.

## API

### Browser Context

- `browser.Affine.init(key: string, swPath?: string): Promise<Affine<T>>`
  Initializes the Affine instance for browser context.

- `affine.give(value: T): Promise<void>`
  Stores a value.

- `affine.take(): Promise<T>`
  Retrieves a stored value. Waits if no value is available.

### Local Context

- `new simple.Affine()`
  Creates a new Affine instance for local context.

- `affine.give(value: T): void`
  Stores a value.

- `affine.take(): Promise<T>`
  Retrieves a stored value. Waits if no value is available.

## License

This project is dual-licensed under either of:

* MIT license ([LICENSE-MIT](LICENSE-MIT) or https://opensource.org/licenses/MIT)
* Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or https://www.apache.org/licenses/LICENSE-2.0)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in this project by you, 
as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
