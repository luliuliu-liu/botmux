import type {Server} from 'node:http';
export type ProxyConfiguration={mode:'global'|'routed';url:string;defaultAction:'proxy'|'direct';rules:Array<{host:string;action:'proxy'|'direct'}>;profileId?:string;revision?:number};
export const proxyEnvironmentKeys:string[];
export function proxyFile(home:string):string;
export function readProxy(home:string):ProxyConfiguration|null;
export function proxyEnvironment(configuration:ProxyConfiguration|null):Record<string,string>;
export function routeProxy(host:string,configuration:ProxyConfiguration|null):'proxy'|'direct';
export function upstreamProxy(configuration:ProxyConfiguration):URL;
export function createContainerProxy(configuration:()=>ProxyConfiguration|null):{server:Server;reset:()=>void;close:()=>Promise<void>};
