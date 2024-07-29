use std::io;
use core::cell::UnsafeCell;
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncWriteExt};
use tokio::fs;
use tokio::net::TcpStream;
use core::ops::DerefMut;
use tracing::{trace, debug};

#[cfg(not(feature = "reload"))]
use core::sync::atomic::{AtomicBool, Ordering};

#[cfg(not(feature = "reload"))]
#[cfg_attr(
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "powerpc64",
    ),
    repr(align(128))
)]
#[cfg_attr(
    any(
        target_arch = "arm",
        target_arch = "mips",
        target_arch = "mips32r6",
        target_arch = "mips64",
        target_arch = "mips64r6",
        target_arch = "sparc",
        target_arch = "hexagon",
    ),
    repr(align(32))
)]
#[cfg_attr(target_arch = "m68k", repr(align(16)))]
#[cfg_attr(target_arch = "s390x", repr(align(256)))]
#[cfg_attr(
    not(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "powerpc64",
        target_arch = "arm",
        target_arch = "mips",
        target_arch = "mips32r6",
        target_arch = "mips64",
        target_arch = "mips64r6",
        target_arch = "sparc",
        target_arch = "hexagon",
        target_arch = "m68k",
        target_arch = "s390x",
    )),
    repr(align(64))
)]
pub struct CachePadded<T> (T);

enum LazyFileInner {
    Ready,
    Pending(PathBuf)
}

impl LazyFileInner {
    #[inline]
    pub fn pending_swap(&mut self) -> Option<PathBuf> {
        if let Self::Pending(path) = core::mem::replace(self, Self::Ready) {
            Some(path)
        } else {
            None
        }
    }
}

struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

pub struct LazyFile {
    // use std sync as the state transition will only occur once, avoids context switching. std mutex is an adaptive
    // spin lock into a futex, whereas all of tokio's sync primitives are built on their batch semaphore, which yes
    // is how it should be done if you're a fan of Dijkstra as that's how this was originally introduced, but modern
    // implementations diverge from the theory in the name of performance.
    inner: Mutex<LazyFileInner>,

    // we guard this with the inner mutex, I generally do not like relying on other sync, but this is completely fine.
    // I simply want to avoid holding the mutex guard longer than needed.
    src: UnsafeCell<Option<Vec<u8>>>,

    #[cfg(not(feature = "reload"))]
    loaded: CachePadded<AtomicBool>
}

macro_rules! poison_err {
    () => {
        io::Error::new(
            io::ErrorKind::Other,
            "Lock was poisoned"
        )
    }
}

impl LazyFile {
    #[inline(always)]
    pub fn new<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        trace!("Attempting to create `LazyFile`, checking if path exists...");
        // We must check existence synchronously, as otherwise the radix trie would require sync which would outweigh 
        // the benefits especially considering filesystem caching. 
        if path.as_ref().exists() {
            trace!("Path existed, creating `LazyFile` in the `Pending` state");
            Ok(Self {
                inner: std::sync::Mutex::new(LazyFileInner::Pending(path.as_ref().to_path_buf())),
                src: UnsafeCell::new(None),
                #[cfg(not(feature = "reload"))]
                loaded: CachePadded(AtomicBool::new(false))
            })
        } else {
            debug!("`LazyFile` could not be constructed as the requested path does not exist.");
            Err(io::Error::new(io::ErrorKind::NotFound, "File does not exist"))
        }
    }

    #[cfg(feature = "reload")]
    pub fn replace_src(&self, new: Vec<u8>) -> io::Result<()> {
        // we hold our guard to prevent other threads from reading during the swap. 
        // Reloads are only used in dev servers where contention will be low.
        let Ok(mut guard) = self.inner.lock() else { return Err( poison_err!() ) };
        
        // propagate the fact that we are no longer pending, as loads take place early with `reload` enabled.
        guard.pending_swap();

        // SAFETY: We are holding the guard which prevents any usage of the bytes until dropped.
        unsafe { core::ptr::replace(self.src.get(), Some(new)); }

        drop(guard);
        
        Ok(())
    }

    #[inline(always)]
    fn send_lock(&self) -> io::Result<Sendable<std::sync::MutexGuard<'_, LazyFileInner>>> {
        self.inner.lock().map(Sendable).map_err(|_| poison_err!())
    }

    #[allow(unreachable_code)]
    pub async fn write(&self, dst: &mut TcpStream) -> io::Result<()> {
        // We only need to synchronize our getting of the slice if reload is enabled. As otherwise after initial call
        // the source is never mutated.
        macro_rules! unchecked_write {
            ($this:ident, $dst:ident) => {{
                let __src = match unsafe { & *$this.src.get() } {
                    Some(__inner) => __inner.as_slice(),
                    None => unreachable!()
                };
                
                $dst.write_all(__src).await
            }}
        }
        #[cfg(not(feature = "reload"))] {
            if self.loaded.0.load(Ordering::Relaxed) {
                return unchecked_write!(self, dst);
            }
        }
        // we check our state, if we must load we hold our guard
        {
            let Ok(mut state) = self.send_lock() else { return Err( poison_err!() ) };
            if let Some(path) = state.0.deref_mut().pending_swap() {
                let file = fs::read(path).await?;
                let src = unsafe { &mut *self.src.get() };

                debug_assert!(src.is_none(), "Bytes were not none when lazy file state was pending");

                *src = Some(file);

                #[cfg(not(feature = "reload"))] {
                    self.loaded.0.store(true, Ordering::Release);
                }
            }

            #[cfg(feature = "reload")] {
                unchecked_write!(self, dst)?;
                return Ok(());
            }
        }

        // We do not have the feature `reload` enabled if we got to this point, therefore we do not need any
        // synchronization as the `bytes` will never be mutated.
        unchecked_write!(self, dst)?;
        Ok(())
    }
}

unsafe impl Send for LazyFile {}
unsafe impl Sync for LazyFile {}
