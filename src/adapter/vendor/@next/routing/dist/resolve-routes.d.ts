import type { ResolveRoutesParams, ResolveRoutesResult } from './types';
export declare function resolveRoutes(params: ResolveRoutesParams): Promise<ResolveRoutesResult & {
    logs: string;
}>;
export declare function resolveRoutesImpl(params: ResolveRoutesParams): Promise<ResolveRoutesResult>;
