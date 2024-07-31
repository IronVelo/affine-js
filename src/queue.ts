// SPDX-License-Identifier: MIT OR Apache-2.0

export class Queue<T> {
    private items: T[] = [];
    private head: number = 0;
    private tail: number = 0;
  
    enqueue(element: T): void {
        this.items[this.tail] = element;
        this.tail++;
    }
  
    dequeue(): T | undefined {
        if (this.isEmpty()) {
            return undefined;
        }
        const item = this.items[this.head];
        this.head++;
      
        if (this.head === this.tail) {
            this.clear();
        }
      
        return item;
    }
  
    peek(): T | undefined {
        if (this.isEmpty()) {
            return undefined;
        }
        return this.items[this.head];
    }
  
    isEmpty(): boolean {
        return this.head === this.tail;
    }
  
    size(): number {
        return this.tail - this.head;
    }
  
    clear(): void {
        this.items = [];
        this.head = 0;
        this.tail = 0;
    }
}
