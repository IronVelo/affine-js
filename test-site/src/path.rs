use swift_check::{for_all_ensure, any, eq, range};
use std::path::PathBuf;
use crate::parse::PathIter;
use std::io;

macro_rules! illegal {
    () => {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Segment contains illegal characters"
        )   
    };

    ($fallible:expr) => {
        match $fallible {
            Ok(__res) => __res,
            Err(_) => return Err(illegal!()) 
        }
    }
}

#[inline]
pub fn extend_dist(mut dist: PathBuf, mut path_iter: PathIter) -> io::Result<PathBuf> {
    let Some(first_segment) = path_iter.next() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "No path was provided, ignoring"
        ));
    };

    dist.reserve(128);
    
    match check_segment(first_segment) {
        // SAFETY: `check_segment` only allows valid utf8
        Some(segment) => unsafe { dist.push(core::str::from_utf8_unchecked(segment)) }, 
        None => return Err(illegal!())
    }

    while let Some(segment) = path_iter.next() {
        match check_segment(segment) {
            // SAFETY: `check_segment` only allows valid utf8
            Some(segment) => unsafe { dist.push(core::str::from_utf8_unchecked(segment) )},
            None => return Err(illegal!())
        }
    }

    Ok(dist)
}

#[inline(always)]
#[must_use]
fn check_segment(segment: &[u8]) -> Option<&[u8]> {
    if segment.len() >= swift_check::arch::WIDTH {
        if for_all_ensure(segment, any!(
            range!(b'a'..=b'z'), range!(b'A'..=b'Z'), 
            range!(b'0'..=b'9'), range!(b'-'..=b'.'), eq(b'_')
        )) {
            Some(segment)
        } else {
            None
        }
    } else {
        if matches!(segment, b".." | b".") {
            return None
        }

        let mut pos = 0usize;
        loop {
            match segment.get(pos) {
                Some(seg) if matches!(seg, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-'..=b'.') => {
                    pos += 1;
                },
                Some(_seg) => break None,
                None => break Some(segment)
            }
        }
    }
}
