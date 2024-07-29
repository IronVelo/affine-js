# Simple Dev Server

This contains a simple development server for testing the service worker's correctness. 

## Environment Variables

- `TEST_PORT`: the port for the server to listen on.
- `TEST_SITE_PATH`: The index file, served at the root path `/`
- `TEST_DIST_PATH`: The files which the server will distribute, your javascript, css, whatever.
- `SERVER-THREADS`: The number of threads the server will take advantage of, if you do not provide this the server will
                    leverage all available threads.

These environment variables are provided at compile time, so you must set them prior to compiling the server. 

### Defaults

- `TEST_PORT`: 6969
- `TEST_SITE_PATH`: index.html
- `TEST_DIST_PATH`: dist/
- `SERVER-THREADS`: Number of physical CPUs on the machine

## Requirements

- The latest Rust compiler
- Cargo

## Usage

Set env variables for the current session:
```sh
$ export TEST_PORT=8080
$ export TEST_SITE_PATH=index.html
$ export TEST_DIST_PATH=dist/
$ export SERVER-THREADS=2
```

Compile and run the server:
```sh
$ cargo run --release
```

Compile and run the server with hot-reloads enabled:
```sh
$ cargo run --release --features reload
```

## Why

One night I got bored, felt I would relieve my boredom and be somewhat "productive" by writing a quick HTTP/1 server. 
Ended up taking two hours for something that I could have done in under a minute, but it was a fun process. The only
part that is fair to consider "cool" would be the router, I personally have never seen a router as fast as the one in
this project. While it is not taken much advantage of, if this hosted genuine endpoints it would be quite nice.

### Router

Routing generally takes place after the HTTP request is parsed, this means the path, version, and headers. I question 
this approach, and I believe my approach is a good alternative for future servers. I believe the parsing should all 
be **lazy**. So say an endpoint requires x and y headers and is hosted at /some/endpoint. The HTTP server should parse
what is only necassary. If the endpoint requires the body of course all will be skimmed over. But for protocols like 
HTTP/2 with HPACK, I think the decompression should 100% lazy, and unfortunately we don't see this. 

Lazy parsing brings many complexities, especially with routing. It is no simple endeavor and can be quite error prone 
if not carefully implemented. 

In this server, the HTTP request is parsed at the same time as the routing. So, basically, as the router needs to 
continue traversal of the radix trie, it requests further bytes from the parser which will only yield path segments. 

The parser is zero-copy and leverages SIMD selectively, making parsing larger paths quite efficient. This parsing is
streamed into a radix trie. The radix trie is not your average implementation, as it is written in a way to ensure 
traversal only takes place once per request, leveraging a `get_or_try_create` api. 

The radix trie will either:

- Find a path with the provided path fully parsed, yielding that node and not computing the closure provided to the
  `get_or_try_create` method.
- Not find a path, yielding the closest node, and invoking the provided closure. If that succeeds it will either split 
  or create a child of the closest node. If the closure fails, the remaining path and HTTP request will be ignored, 
  and the server will throw a `404` error. 

In this usage of this paradigm, the closure validates the requested path, ensuring that it is not attempting anything
malicious such as path traversal, and verify that the path exists. It will not load / hold the file handle until later,
as to avoid synchronizing the radix trie no asynchronous operations take place.

In typical use cases with previous approaches, this would be a serious bottleneck. Though, this lazy parsing / routing
paradigm is the exception. Under load testing, the routing took place for your typical path (two segments, moderate 
len ~16 bytes per segment) in only ~200 CPU cycles (22-30 nanoseconds, 5GHz CPU). This type of performance has not 
been seen before in HTTP servers, making this approach to routing highly applicable to real-time systems. These 
performance metrics were observed when using `ApacheBench` with 1 million request at a concurrency level of 100. 

### Overall Performance

While the router is exceptionally fast, the server's performance matches nginx. This is not a limitation of the router
by any means, but actually the async runtime being used. 

If I were to continue working on this, I would change a few things:

- **Runtime**: Write a custom runtime with a compatibility layer for more general purpose runtimes for user 
  applications being served. This runtime would be tailored around HTTP servers, and I would only implement it for unix
  based operating systems as who cares about windows (though I am an seL4 fan, but then you're in embedded world).
- **Kernel Bypass**: The `sendfile` syscall is not very async friendly, so currently the server holds the file contents
  in memory. This is to avoid needing to ensure mutual exclusion on file handles. Generally, streaming these bytes to 
  the TCP stream is not zero-copy in kernel space. Though, there's lower-level approaches that don't require privelidge
  escalation that can circumvent this overhead such as `DPDK` and `AF_XDP`. Also, despite all of the security 
  challenges it has seen, `io_uring` can provide benefits, though better performance would be achieved using either 
  of the previously listed high-performance networking frameworks (granted with extra work, especially for `DPDK`). 


