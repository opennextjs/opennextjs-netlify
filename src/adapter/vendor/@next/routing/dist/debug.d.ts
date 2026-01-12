import { AsyncLocalStorage } from 'node:async_hooks';
export type RequestTracker = {
    logs: string;
};
export declare const RequestTrackerAsyncLocalStorage: AsyncLocalStorage<RequestTracker>;
export declare function debugLog(...args: unknown[]): void;
