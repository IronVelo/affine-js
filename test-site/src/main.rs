use tokio::net::{TcpListener, TcpStream};
use std::net::SocketAddr;
use std::path::Path;
#[cfg(feature = "reload")]
use std::path::PathBuf;
use std::io::{self, IoSlice};
use tokio::io::{AsyncWriteExt, AsyncReadExt};
use tracing::{instrument, trace, debug, info, warn, Level};

#[cfg(feature = "reload")]
use std::time::SystemTime;
#[cfg(feature = "reload")]
use tokio::fs;

mod parse;
use parse::{PathIter, get_req_path};
mod mime;
mod path;
mod route;
use route::Tree;
mod lazy_file;
use lazy_file::LazyFile;

#[must_use]
struct ServerConf {
    port: u16,
    index: &'static str,
    dist: &'static str,
    threads: usize
}

impl ServerConf {
    #[instrument(name = "load-server-conf", err(Debug, level = Level::DEBUG))]
    pub fn from_env() -> io::Result<Self> {
        let port = option_env!("TEST_PORT")
            .unwrap_or("6969")
            .parse()
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("Invalid port: {}", e)))?;
        
        let index = option_env!("TEST_SITE_PATH").unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/index.html"));
        let dist = option_env!("TEST_DIST_PATH").unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/dist"));
        let threads = option_env!("SERVER-THREADS").and_then(|raw| match raw.parse() {
            Ok(tc) => {
                info!("Using {tc} threads...");
                Some(tc)
            },
            Err(e) => {
                warn!("Requested thread count was not a number: {e:?}");
                None
            }
        }).unwrap_or_else(|| num_cpus::get());

        macro_rules! cfg_has {
            ($meta:meta) => {{
                #[cfg($meta)] {
                    true
                }
                #[cfg(not($meta))] {
                    false
                }
            }}
        }

        const RELOADS: bool = cfg_has!(feature = "reload");
        const BAD_CACHE: bool = cfg_has!(feature = "bad-cache");

        info!(
            "Server Configuration:\
            \n\t TEST_SITE_PATH: {index},\
            \n\t TEST_DIST_PATH: {dist},\
            \n\t TEST_PORT: {port},\
            \n\t SERVER-THREADS: {threads},\
            \n\t HOT RELOADS: {RELOADS},\
            \n\t 404 CACHING: {BAD_CACHE}",
        );
        
        Ok(Self { port, index, dist, threads })
    }
}

fn main() -> io::Result<()> {
    tracing_subscriber::fmt()
        .pretty()
        .with_timer(tracing_subscriber::fmt::time::time())
        .with_max_level(Level::TRACE)
        .with_file(false)
        .with_line_number(false)
        .init();

    let conf = ServerConf::from_env()?;
    let addr = SocketAddr::from(([127, 0, 0, 1], conf.port));
    
    tokio::runtime::Builder::new_multi_thread()
        .enable_io()
        .worker_threads(conf.threads)
        .build()
        .and_then(move |rt| rt.block_on(make_serve(addr, conf)))
}

#[instrument(name = "server", skip(conf), level = Level::DEBUG)]
async fn make_serve(addr: SocketAddr, conf: ServerConf) -> io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    let index = Box::leak(Box::new(IndexFile::new(conf.index)?));

    // SAFETY: all mutable operations on dist_handler are completely synchronous (0 interrupts) and on the main 
    // thread. 
    let dist_handler = core::cell::UnsafeCell::new(Box::leak(Box::new(DistHandler::new(conf.dist))));

    info!("Server listening...");

    loop {
        let _ = match listener.accept().await {
            Ok((stream, remote_addr)) => {
                debug!("Connection {remote_addr} accepted");
                conn_handler(stream, index, unsafe { &mut *dist_handler.get() }).await
            },
            Err(e) => {
                warn!("Error accepting connection: {e:?}");
                continue
            }
        };
    }
}

macro_rules! serve_file {
    (@mime $stream:ident $(,)?) => {
        $stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n").await
    };
    (@mime $stream:ident, $mime:ident) => {
        $stream.write_vectored(&[
            IoSlice::new(b"HTTP/1.1 200 OK\r\nContent-Type: "),
            IoSlice::new($mime.as_bytes()),
            IoSlice::new(b"\r\n\r\n")
        ]).await
    };
    ($stream:ident, $file:expr $(, $mime:ident)?) => {
        match serve_file!(@mime $stream $(, $mime)?) {
            Ok(_) => match $file.write(&mut $stream).await {
                Ok(_a) => {
                    debug!("Finished serving request, flushing...");
                    $stream.flush().await
                },
                Err(err) => Err(err)
            },
            Err(err) => Err(err)
        }
    };
}

macro_rules! or_404 {
    ($fallible:expr, $stream:ident, || $or:expr, |$ret:ident| $ok:expr) => {
        match $fallible {
            Ok($ret) => $ok,
            Err(__err) => {
                tokio::spawn(write_status($stream, "404", "Not Found")).await??;
                debug!("Served 404 error: {__err:?}");
                $or
            }
        }
    }
}

#[inline]
#[instrument(
    name = "request",
    skip(index, d_h),
    err(Debug, level = Level::DEBUG),
    level = Level::DEBUG
)]
async fn conn_handler<P>(
    mut stream: TcpStream, 
    index: &'static IndexFile<P>, d_h: &'static mut DistHandler
) -> io::Result<()> 
    where P: AsRef<Path> + core::fmt::Debug + Send + Sync
{
    stream.set_nodelay(true)?;
    let buf = Buf::<{ 2usize.pow(10) }>::read(&mut stream).await?;
    trace!("Successfully read the request");

    if let Some(d_re) = or_404!(d_h.try_route(buf.get()), stream, || return Ok(()), |r| r) {
        trace!("Routed to dist directory...");
        tokio::spawn(serve_dist(stream, d_re));
    } else {
        trace!("Routed to the index file...");
        tokio::spawn(serve_index(stream, index));
    };

    Ok(())
}

async fn serve_index<P>(mut stream: TcpStream, index: &'static IndexFile<P>) -> io::Result<()>
    where P: AsRef<Path> + core::fmt::Debug + Sync + Send
{
    #[cfg(feature = "reload")] {
        index.reload.maybe(&index.file).await?;
    }
    serve_file!(stream, &index.file)
}

#[inline(always)]
async fn serve_dist(mut stream: TcpStream, d_re: &'static DistReload) -> io::Result<()> {
    let (file, mime) = (&d_re.file, d_re.mime);
    #[cfg(feature = "reload")] {
        d_re.reload.maybe(file).await?;
    }
    serve_file!(stream, file, mime)
}

#[must_use]
struct Buf<const C: usize> {
    buf: [u8; C],
    len: usize
}

impl<const C: usize> Buf<C> {
    #[inline]
    pub async fn read(stream: &mut TcpStream) -> io::Result<Self> {
        let mut buf = [0; C];
        stream.read(&mut buf).await.map(move |len| Self { buf, len })
    }

    #[inline]
    pub fn get<'a>(&'a self) -> &'a [u8] {
        &self.buf[..self.len]
    }
}

#[cfg(feature = "reload")]
struct IndexFile<P> {
    file: LazyFile,
    reload: Reload<P>
}

#[cfg(not(feature = "reload"))]
#[repr(transparent)]
struct IndexFile<P> {
    file: LazyFile,
    _p: core::marker::PhantomData<P>
}

impl<P: AsRef<Path> + core::fmt::Debug> IndexFile<P> {
    #[inline]
    pub fn new(path: P) -> io::Result<Self> {
        LazyFile::new(path.as_ref()).map(|file| Self {
            file,
            #[cfg(feature = "reload")]
            reload: Reload::new(path),
            #[cfg(not(feature = "reload"))]
            _p: core::marker::PhantomData
        })
    }
}

struct DistHandler {
    seen: Tree<'static, DistReload>,
    dist: &'static str,
    #[cfg(feature = "bad-cache")]
    bc: std::sync::Mutex<lru::LruCache<std::path::PathBuf, ()>>
}

impl DistHandler {
    #[must_use]
    #[inline]
    pub fn new(dist: &'static str) -> Self {
        Self {
            seen: Tree::new_static(),
            dist,
            #[cfg(feature = "bad-cache")]
            bc: std::sync::Mutex::new(lru::LruCache::new(core::num::NonZeroUsize::new(8).unwrap()))
        }
    }

    #[inline(always)]
    pub fn try_route(&'static mut self, raw: &[u8]) -> io::Result<Option<&'static DistReload>>  {
        let e = std::time::Instant::now();

        #[cfg(feature = "bad-cache")]
        let bc = &self.bc;

        let dist = self.dist;
        match get_req_path(raw) { 
            Ok(path) if path.next_known_terminal() => Ok(None),
            Ok(path) => match self.seen.get_or_try_create(
                path,
                move |parsed| DistReload::new(
                    dist, path, parsed,
                    #[cfg(feature = "bad-cache")]
                    bc
                )
            ) {
                Ok(d_re) => {
                    info!("Total route time: {:?}", e.elapsed());
                    Ok(Some(d_re))
                },
                Err(err) => {
                    info!("error time: {:?}", e.elapsed());
                    Err(err)
                }
            },
            Err(e) => Err(io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))
        }
    }
}

struct DistReload {
    #[cfg(feature = "reload")]
    reload: Reload<PathBuf>,
    file: LazyFile,
    mime: &'static str,
}

impl DistReload {
    #[inline(always)]
    #[cfg(all(unix, feature = "bad-cache"))]
    pub fn check_cache(
        mut parsed: PathIter, 
        bc: &std::sync::Mutex<lru::LruCache<std::path::PathBuf, ()>>
    ) -> io::Result<()> {
        trace!("Checking cache for the path (unix)");
        let now = std::time::Instant::now();

        // ensure iterator is exhausted
        while parsed.next().is_some() {}

        trace!("Time took for exhausting path iterator: {:?}", now.elapsed());

        // get the entirety of what we have parsed
        let parsed_slice = parsed.get_parsed();

        // now for the unsafe, platform specific things... 
        let path: &Path = unsafe {
            // Path carries the same representation as OsStr. 
            // OsStr carries the same representation as sys::Slice.
            // sys::Slice carries the same representation as [u8]
            // 
            // This is of course, only for unix based operating systems, as less cultured operating systems like 
            // windows use a utf16 representation for paths. Technically, this possibly is safe on windows, though,
            // I'm not interested in chancing it, and odds are windows users do not care for this level of performance.
            core::mem::transmute(parsed_slice)
        };

        let mut guard = bc.lock().map_err(|_| io::Error::new(io::ErrorKind::Other, "Poisoned lock for LRU cache"))?;
        let res = guard.get(path).is_some();
        drop(guard);

        if res {
            Err(io::Error::new(io::ErrorKind::InvalidData, "Path does not exist"))
        } else {
            Ok(())
        }
    }
 

    #[instrument(
        name = "load-file",
        skip_all, fields(dist = dist),
        err(Debug, level = Level::DEBUG),
        level = Level::DEBUG
    )]
    pub fn new(
        dist: &'static str, path: PathIter, parsed: PathIter,
        #[cfg(feature = "bad-cache")]
        bc: &std::sync::Mutex<lru::LruCache<std::path::PathBuf, ()>>
    ) -> io::Result<Self> {
        #[cfg(all(unix, feature = "bad-cache"))] {
            Self::check_cache(parsed, bc)?;
        }

        trace!("Checking for potential path traversal...");
        let p_buf = path::extend_dist(Path::new(dist).to_path_buf(), path)?;

        info!("Attempting to load {}", p_buf.display());
        #[cfg(all(feature = "bad-cache", not(unix)))] {
            drop(parsed);
            trace!("Checking cache for the path");
            let mut guard = bc.lock().map_err(|_| io::Error::new(io::ErrorKind::Other, "Poisoned lock for LRU cache"))?;
            if guard.get(&p_buf).is_some() {
                debug!("Found in the `bad-cache`, rejecting request");
                return Err(io::Error::new(io::ErrorKind::InvalidData, "Path does not exist"));
            }
            drop(guard);
        }

        match LazyFile::new(p_buf.as_path()) {
            Ok(file) => {
                let mime = p_buf.as_path().extension()
                    .and_then(|ext| ext.to_str())
                    .and_then(|ext| mime::from_ext(ext))
                    .unwrap_or("application/octet-stream");
                Ok(Self {
                    #[cfg(feature = "reload")]
                    reload: Reload::new(p_buf),
                    file,
                    mime
                })
            },
            Err(err) => {
                #[cfg(feature = "bad-cache")] {
                    debug!("Path did not exist, adding to the `bad-cache`");
                    let mut guard = bc.lock()
                        .map_err(|_| io::Error::new(io::ErrorKind::Other, "Poisoned lock for LRU cache"))?;

                    guard.put(p_buf.strip_prefix(dist).unwrap(/* infallible */).to_path_buf(), ());
                }
                Err(err)
            }
        }
    }
}

#[cfg(feature = "reload")]
use core::sync::atomic::{AtomicU64, Ordering};

#[cfg(feature = "reload")]
struct Reload<P> {
    last_modified: AtomicU64,
    path: P
}

#[cfg(feature = "reload")]
impl<P: AsRef<Path> + core::fmt::Debug> Reload<P> {
    #[must_use]
    pub const fn new(path: P) -> Self {
        Self { 
            path, 
            last_modified: AtomicU64::new(0) 
        }
    }

    #[instrument(
        name = "maybe-refresh-file", 
        skip_all, 
        fields(path = tracing::field::debug(&self.path)), 
        err(Debug, level = Level::DEBUG),
        level = Level::DEBUG
    )]
    pub async fn maybe(&self, file: &LazyFile) -> io::Result<()> {
        macro_rules! extract {
            ($fallible:expr, $ctx:literal) => {
                match $fallible {
                    Ok(__res) => __res,
                    Err(__err) => {
                        warn!("{}, continuing anyways. Reason: {__err:?}", $ctx);
                        return Ok(())
                    }
                }
            }
        }
        let metadata = extract!(fs::metadata(self.path.as_ref()).await, "Could not read file metadata");
        let modified = extract!(
            metadata.modified().and_then(|dur| dur
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e))),
            "Could not read file last modified timestamp"
        ).as_secs();

        let last_modified = self.last_modified.swap(modified, Ordering::AcqRel);

        if modified > last_modified {
            info!("File changed, reloading...");
            tokio::fs::read(&self.path).await.map(|re_file| file.replace_src(re_file))?
        } else {
            Ok(())
        }
    }
}

#[inline]
async fn write_status(mut stream: TcpStream, status: &'static str, msg: &'static str) -> io::Result<usize> {
    stream.write_vectored(&[
        IoSlice::new(b"HTTP/1.1 "),
        IoSlice::new(status.as_bytes()),
        IoSlice::new(b" "),
        IoSlice::new(msg.as_bytes()),
        IoSlice::new(b"\r\nContent-Type: text/plain\r\n\r\n"),
        IoSlice::new(msg.as_bytes())
    ]).await
}
