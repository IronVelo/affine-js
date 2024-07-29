interface AffineData<T> {
    value: T | null;
    waitQueue: MessagePort[];
}
type AffineStore = {
    [key: string]: AffineData<unknown>;
};
interface AffineMsg {
    action: "take" | "give";
    key: string;
    value?: any;
}
declare function takeHandler(store: AffineStore, key: string, port: MessagePort): void;
declare function giveHandler(store: AffineStore, key: string, value: any, port: MessagePort): void;
declare function eventHandler(store: AffineStore): (event: ExtendableMessageEvent) => void;
declare const affineStore: AffineStore;
