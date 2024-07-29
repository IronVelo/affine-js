//! Simple parser combinatorics for H1
use swift_check::{search, eq, any};
use core::iter::FusedIterator;
use core::fmt;

#[derive(Debug)]
pub enum ParseError<'src> {
    Expected { expected: &'static str, found: &'src [u8] },
    EndOfInput,
    Complete
}

impl<'src> fmt::Display for ParseError<'src> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Self::Expected { expected, found } => write!(f, "ParseError {{ expected: {expected}, found: {found:?} }}"),
            Self::EndOfInput => f.write_str("ParseError {{ EndOfInput }}"),
            Self::Complete => f.write_str("ParseError {{ Complete }}")
        }
    }
}

impl<'src> std::error::Error for ParseError<'src> {}

type Rem<'src> = &'src [u8];
type PResult<'src, T> = Result<(Rem<'src>, T), ParseError<'src>>;

macro_rules! tag {
    ($(#[$attr:meta])* $vis:vis fn $func:ident is $tag:literal) => {
        $(#[$attr])*
        $vis fn $func <'src> (raw: &'src [u8]) -> PResult<'src, &'static str /* tag */> {
            match raw.get(..$tag.len()) {
                Some(trimmed_raw) if trimmed_raw == $tag.as_bytes() => Ok((&raw[$tag.len()..], $tag)),
                _ => Err(ParseError::Expected { expected: $tag, found: raw })
            }
        }
    };

    // for higher-order usage
    ($func:ident is $tag:literal) => {{
        tag!{
            #[inline(always)]
            fn $func is $tag
        }
        $func
    }}
}

/// Takes until the `byte` or any whitespace
#[inline(always)]
fn take_until<'src>(raw: &'src [u8], byte: u8) -> PResult<'src, &'src [u8]> {
    // we search the first 32 bytes, if we don't find a match and there's at least a reg width remaining we yield to
    // SIMD
    let normal_search = core::cmp::min(32, raw.len());
    match (&raw[..normal_search]).iter().position(|o_byte| (*o_byte == byte) | matches!(o_byte, b' ' | b'~')) {
        Some(pos) => Ok((&raw[pos..], &raw[..pos])),
        None => {
            if raw.len() == normal_search { return Err(ParseError::EndOfInput); }
            
            if raw.len() >= (swift_check::arch::WIDTH + 32) {
                match search(&raw[normal_search..], any!(eq(byte), eq(b' '), eq(b'~'))) {
                    Some(pos) => Ok((&raw[normal_search + pos + 1..], &raw[..normal_search + pos])),
                    _ => Err(ParseError::EndOfInput)
                }
            } else {
                match (&raw[normal_search..])
                    .iter()
                    .position(|o_byte| (*o_byte == byte) | matches!(o_byte, b' ' | b'~')) {
                    Some(pos) => Ok((&raw[normal_search + pos + 1..], &raw[..normal_search + pos])),
                    None => Err(ParseError::EndOfInput)
                }
            }
        }
    }
}

#[inline]
fn take_path_seg<'src>(mut raw: &'src [u8]) -> PResult<'src, &'src [u8]> {
    if let Ok((rem, _)) = tag!(slash is "/")(raw) {
        raw = rem;
    }
    take_until(raw, b'/')
}

macro_rules! ident_cond {
    () => { 
        any!(
            eq(b' '), eq(b'\r'), eq(b'/')
        )
    }
}

/// A legal ident for simplicity is a-z, A-Z, 0-9, _, .
#[inline(always)]
fn take_ident<'src>(raw: &'src [u8]) -> PResult<'src, &'src [u8]> {
    let normal_search = core::cmp::min(32, raw.len());
    match (&raw[..normal_search]).iter().position(|byte| matches!(byte, b' ' | b'\r' | b'/')) {
        Some(pos) if pos == 0 => Err(ParseError::Expected { expected: "ident", found: raw }),
        Some(pos) => Ok((&raw[pos..], &raw[..pos])),
        None => {
            if raw.len() == normal_search { return Err(ParseError::EndOfInput); }

            if raw.len() >= (swift_check::arch::WIDTH + 32) {
                match search(&raw[normal_search..], ident_cond!()) {
                    Some(pos) => Ok((&raw[pos + normal_search..], &raw[..pos + normal_search])),
                    None => Ok(("".as_bytes(), raw)) 
                }         
            } else {
                match (&raw[normal_search..]).iter().position(|byte| matches!(byte, b' ' | b'\r' | b'/'))  {
                    Some(pos) => Ok((&raw[normal_search + pos..], &raw[..normal_search + pos])),
                    None => Ok(("".as_bytes(), raw))
                }
            }
        }
    }
}

#[must_use = "Iterators are lazy"]
#[derive(Copy, Clone)]
pub struct PathIter<'src> {
    complete: bool,
    remainder: &'src [u8],
    start: *const u8
}

impl<'src> PathIter<'src> {
    #[inline]
    pub const fn new(raw: &'src [u8]) -> Self {
        Self { complete: false, remainder: raw, start: raw.as_ptr() }
    }

    #[inline]
    pub fn get_parsed(&self) -> &'src [u8] {
        unsafe {
            let parsed_len = self.remainder.as_ptr().offset_from(self.start) as usize;
            // This is safe because:
            // 1. start is within the original slice
            // 2. The lifetime 'src ensures the source data is still valid
            std::slice::from_raw_parts(self.start, parsed_len)
        }
    }

    #[allow(dead_code)]
    #[cold]
    #[inline]
    #[must_use]
    pub const fn remainder(&self) -> &'src [u8] {
        self.remainder
    }

    #[allow(dead_code)]
    #[cold]
    #[inline]
    #[must_use]
    pub const fn is_complete(&self) -> bool {
        self.complete
    }

    #[inline]
    #[must_use]
    pub fn peek_complete(&self) -> bool {
        self.complete || self.next_known_terminal()
    }

    #[inline]
    #[must_use]
    pub fn peek(&self) -> Option<u8> {
        self.remainder.first().copied()
    }

    #[inline(always)]
    #[must_use]
    pub fn next_is(&self, other: u8) -> bool {
        self.peek() == Some(other)
    }

    #[inline(always)]
    pub fn take(&mut self, other: u8) {
        if self.next_is(other) {
            self.remainder = &self.remainder[1..];
        }
    }

    #[inline(always)]
    #[must_use]
    pub fn next_is_opt(&self, other: Option<&u8>) -> bool {
        match (self.remainder.first(), other) {
            (Some(b'/'), Some(other)) => match self.remainder.get(1) {
                Some(our) => our == other,
                None => false
            },
            (Some(our), Some(other)) => our == other,
            _ => false
        }
    }

    #[inline(always)]
    #[must_use]
    pub fn move_match<'o>(&mut self, other: &'o [u8]) -> &'o [u8] {
        use core::cmp::Ordering;
        macro_rules! find_dif {
            ($this:ident, $res:ident, $other:ident, min: $m_len:ident, eaten: $eaten:ident, $l:lifetime) => {{
                if $m_len == 0 {
                    break $l;
                }
                for __i in 0..$m_len {
                    if $res[__i] != $other[$eaten.wrapping_add(__i)] {
                        $this.remainder = &$this.remainder[__i..];
                        $eaten = ($eaten.wrapping_add(__i));
                        break $l;
                    }
                }
                $this.remainder = &$this.remainder[$m_len..];
                $eaten = $eaten.wrapping_add($m_len);
            }}
        }

        if other.is_empty() {
            return other;
        }

        let mut eaten = 0usize;
        'outer: while other.len() > eaten {
            let Ok((_, res)) = self.parse_next() else { break };
            let (r_len, o_len) = (res.len(), other.len());
            match r_len.cmp(&(o_len - eaten)) {
                Ordering::Less => find_dif!(self, res, other, min: r_len, eaten: eaten, 'outer),
                Ordering::Equal | Ordering::Greater => find_dif!(self, res, other, min: o_len, eaten: eaten, 'outer)
            }
        }

        self.take(b'/');

        &other[..eaten]
    }

    #[allow(dead_code)]
    #[cold]
    #[inline]
    #[must_use]
    pub fn peek_ref(&self) -> Option<&'src [u8]> {
        if self.remainder.len() > 0 {
            Some(&self.remainder[..1])
        } else {
            None
        }
    }

    #[allow(dead_code)]
    #[cold]
    #[inline]
    #[must_use]
    pub fn peek_utf8(&self) -> Option<&str> {
        self.peek_ref().and_then(|peeked| core::str::from_utf8(peeked).ok())
    }

    /// Returns `true` IIF `peek` is a space or empty
    #[inline]
    #[must_use]
    pub fn next_known_terminal(&self) -> bool {
        matches!(self.peek(), Some(b' ') | None) 
    }

    #[inline(always)]
    pub fn parse_next(&self) -> PResult<'src, &'src [u8]> {
        if self.complete || self.next_known_terminal() {
            return Err(ParseError::Complete);
        }
        match take_path_seg(self.remainder) {
            res @ Ok(_) => res,
            Err(_) if self.next_known_terminal() => Err(ParseError::Complete),
            Err(_ /* No further path sep, take ident */) => match take_ident(self.remainder) {
                res @ Ok(_) => res,
                Err(_) => Err(ParseError::Complete)
            }
        }
    }
}

impl<'src> Iterator for PathIter<'src> {
    type Item = &'src [u8];

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        match self.parse_next() {
            Ok((rem, res)) => {
                self.remainder = rem;
                Some(res)
            },
            Err(_) => {
                self.complete = true;
                None
            }
        }
    }
}

impl<'src> FusedIterator for PathIter<'src> {}

#[inline]
pub fn get_req_path<'src>(raw: &'src [u8]) -> Result<PathIter<'src>, ParseError<'src>> {
    tag!(get_method is "GET /")(raw).map(|(rem, _)| PathIter::new(rem))
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! strcmp {
        (opt => str ( $something:expr )) => {
            match $something.map(|__thing| strcmp!(str(__thing))) {
                Some(__res) => __res,
                None => panic!("Attempted to unwrap {:?} when was `None`", $something)
            }
        };
        (str ($something:expr)) => {
            ::core::str::from_utf8($something).unwrap()
        };
        (opt $lhs:expr, $rhs:expr) => {
            assert_eq!(strcmp!(opt => str($lhs)), strcmp!(str($rhs)))
        };
        ($lhs:expr, opt $rhs:expr) => {
            assert_eq!(strcmp!(str($lhs)), strcmp!(opt => str($rhs)))
        };
        (opt $lhs:expr, opt $rhs:expr) => {
            assert_eq!(strcmp!(opt => str($lhs)), strcmp!(opt => str($rhs)))
        };
        ($lhs:expr, $rhs:expr) => {
            assert_eq!(strcmp!(str($lhs)), strcmp!(str($rhs)))
        };
    }

    #[test]
    fn smoke_p_iter() {
        let basic = b"hello/world/goodbyte/world.js remainder";

        let mut iter = PathIter::new(basic);
        strcmp!(opt iter.next(), b"hello");
        strcmp!(opt iter.next(), b"world");
        strcmp!(opt iter.next(), b"goodbyte");
        strcmp!(opt iter.next(), b"world.js");
        assert_eq!(iter.next(), None);

        strcmp!(iter.remainder(), b" remainder");
    }
    #[test]
    fn long_test() {
        let first = b"heeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeellllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllloooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo";

        let mut to_parse = first.to_vec();
        to_parse.extend_from_slice(b"/world.txt/");

        dbg!(strcmp!(str (to_parse.as_slice())));

        let mut iter = PathIter::new(to_parse.as_slice());
        dbg!(iter.peek_utf8());

        strcmp!(opt iter.next(), first.as_slice());
        strcmp!(opt iter.next(), b"world.txt");
        assert_eq!(iter.next(), None);


    }
}
