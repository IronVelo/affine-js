use bumpalo::{Bump, collections::Vec};
use core::cell::UnsafeCell;
use crate::parse::PathIter;
use core::ops::Deref;
use core::fmt;

#[derive(Debug)]
pub struct Tree<'b, T> {
    root: Node<'b, T>,
    arena: &'b Bump,
}

pub struct Node<'b, T> {
    prefix: Vec<'b, u8>,
    priority: u32,
    children: Vec<'b, Self>,
    value: Option<T>
}

impl<'b, T: fmt::Debug> fmt::Debug for Node<'b, T> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("Node")
            .field("prefix", &core::str::from_utf8(self.prefix.as_slice()))
            .field("priority", &self.priority)
            .field("children", &self.children)
            .field("value", &self.value)
            .finish()
    }
}

enum Acquired<'b, 'r, T> {
    Root(&'b mut Node<'b, T>, PathIter<'r>),
    Exact(&'b mut Node<'b, T>),
    SplitClosest(&'b mut Node<'b, T>, usize, PathIter<'r>),
    CreateClosest(&'b mut Node<'b, T>, PathIter<'r>) 
}

#[repr(transparent)]
#[must_use]
struct Cur<'b, T> {
    cell: UnsafeCell<&'b mut Node<'b, T>>
}

impl<'b, T> Cur<'b, T> {
    #[inline(always)]
    pub fn new(t: &'b mut Node<'b, T>) -> Self {
        Self { cell: UnsafeCell::new(t) }
    }

    #[inline(always)]
    pub fn get(&self) -> &'b mut Node<'b, T> {
        unsafe { *self.cell.get() }
    }
}

impl<'b, T> Deref for Cur<'b, T> {
    type Target = Node<'b, T>;

    #[inline]
    fn deref(&self) -> &Self::Target {
        self.get()
    }
}

impl<'b, T> Node<'b, T> {
    #[inline]
    #[must_use]
    pub fn empty(arena: &'b Bump) -> Self {
        Self {
            prefix: Vec::new_in(arena),
            priority: 0,
            children: Vec::new_in(arena),
            value: None
        }
    }

    #[inline]
    #[must_use]
    pub fn prefix(&self) -> &[u8] {
        self.prefix.as_slice()
    }

    #[inline(always)]
    fn acquire<'r>(&'b mut self, route: &mut PathIter<'r>) -> Acquired<'b, 'r, T> {
        if self.prefix.is_empty() && self.children.is_empty() {
            return Acquired::Root(self, *route);
        }

        let mut current = Cur::new(self);

        loop {
            let matched = route.move_match(current.prefix());
            if route.peek_complete() {
                return Acquired::Exact(current.get());
            }

            if matched.len() < current.prefix.len() {
                current.get().priority += 1;
                return Acquired::SplitClosest(current.get(), matched.len(), *route);
            }

            if let Some(child) = current.get().children.iter_mut().find(|c| route.next_is_opt(c.prefix.first())) {
                current = Cur::new(child);
            } else {
                current.get().priority += 1;
                return Acquired::CreateClosest(current.get(), *route);
            }
        }
    }
}

impl<T> Tree<'static, T> {
    /// Create a new [`Tree`] with a `static` lifetime (intentionally leaked memory)
    #[must_use]
    pub fn new_static() -> Self {
        let bump = Box::leak(Box::new(Bump::new()));
        Tree::new(bump)
    }
}

impl<'b, T> Tree<'b, T> {
    #[inline]
    #[must_use]
    pub fn new(bump: &'b Bump) -> Self {
        Self {
            root: Node::empty(bump),
            arena: bump
        }
    }

    pub fn get_or_try_create<'r, F, E>(&'b mut self, mut path: PathIter<'r>, f: F) -> Result<&'b T, E>
        where F: FnOnce(PathIter<'r>) -> Result<T, E>
    {
        let m_self = UnsafeCell::new(self);
        match unsafe { &mut *m_self.get() }.root.acquire(&mut path) {
            Acquired::Exact(node) => {
                if node.value.is_none() {
                    node.value = Some(f(path)?);
                }
                match &mut node.value {
                    Some(value) => Ok(value),
                    // SAFETY: If the node was `None` we assigned the `Ok` of `f` to the value. If `f` failed we did 
                    // not make it to this point. Thus at this point `node.value` cannot be `None`.
                    None => unsafe { core::hint::unreachable_unchecked() }
                }
            },
            Acquired::Root(mut node, mut rem_path) => match f(rem_path) {
                Ok(new_value) => {
                    let arena = unsafe { & *m_self.get() }.arena;
                    let priority = node.priority;

                    if let Some(segment) = rem_path.next() {
                        node.prefix = Vec::from_iter_in(segment.iter().copied(), arena);
                    }

                    while let Some(segment) = rem_path.next() {
                        node.children.push(Node {
                            priority,
                            prefix: Vec::from_iter_in(segment.iter().copied(), arena),
                            children: Vec::new_in(arena),
                            value: None
                        });

                        node = node.children.last_mut().unwrap();
                    }

                    node.value = Some(new_value);
                    Ok(node.value.as_mut().unwrap())
                },
                Err(err) => Err(err)
            },
            Acquired::SplitClosest(node, common, rem_path) => match f(rem_path) {
                Ok(new_value) => {
                    let split = unsafe { & *m_self.get() }.split_node(node, common, rem_path);
                    split.value = Some(new_value);
                    Ok(split.value.as_mut().unwrap())
                },
                Err(err) => Err(err)
            },
            Acquired::CreateClosest(node, rem_path) => match f(rem_path) {
                Ok(new_value) => {
                    let new = unsafe { & *m_self.get() }.create_child(node, rem_path);
                    new.value = Some(new_value);
                    Ok(new.value.as_mut().unwrap())
                },
                Err(err) => Err(err) 
            }
        }
    }

    fn split_node<'r>(&'b self, node: &'b mut Node<'b, T>, common: usize, mut rest: PathIter<'r>) -> &'b mut Node<'b, T> {
        if common < node.prefix.len() {
            // Split the current node
            let new_child = Node {
                prefix: Vec::from_iter_in(node.prefix[common..].iter().copied(), self.arena),
                priority: node.priority,
                children: core::mem::replace(&mut node.children, Vec::new_in(self.arena)),
                value: node.value.take(),
            };
            node.prefix.truncate(common);
            node.children.push(new_child);
        }

        if let Some(next_segment) = rest.next() {
            // Create a new child for the diverging part
            let new_child = Node {
                prefix: Vec::from_iter_in(next_segment.iter().copied(), self.arena),
                priority: 1,
                children: Vec::new_in(self.arena),
                value: None,
            };
            node.children.push(new_child);
            self.create_child(node.children.last_mut().unwrap(), rest)
        } else {
            node
        }
    }

    fn create_child<'r>(&'b self, parent: &'b mut Node<'b, T>, rest_path: PathIter<'r>) -> &'b mut Node<'b, T> {
        let mut current = parent;
        for segment in rest_path {
            let new_node = Node {
                prefix: Vec::from_iter_in(segment.iter().copied(), self.arena),
                priority: 1,
                children: Vec::new_in(self.arena),
                value: None,
            };
            current.children.push(new_node);
            current = current.children.last_mut().unwrap();
        }

        current
    }
}

