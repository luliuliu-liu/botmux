/** Docker reference helpers shared by the image catalogue and every image
 * selector. Registry hosts belong in the source column, never in the name. */
export function splitImageRef(ref:string):{registry:string|null;short:string}{
  const segments=ref.split('/');
  const first=segments[0]??'';
  // A leading segment is a registry host only when it contains a dot or port,
  // or is the reserved localhost name.
  if(segments.length>1&&(first.includes('.')||first.includes(':')||first==='localhost')){
    return {registry:first,short:segments[segments.length-1]!};
  }
  return {registry:null,short:ref};
}
export function shortImageRef(ref:string){return splitImageRef(ref).short;}
export function registryHostOf(ref:string){return splitImageRef(ref).registry;}
export function registryHostOfTags(tags:string[]):string|null{
  for(const tag of tags){const host=registryHostOf(tag);if(host)return host;}
  return null;
}
/** Full host/namespace source plus bare repository of a registry-prefixed tag
 * (e.g. host/ns/worker-agent:pi-… → {registry:'host/ns', repository:'worker-agent'}). */
export function remoteSourceOfTags(tags:string[]):{registry:string;repository:string}|null{
  for(const ref of tags){
    const segments=ref.split('/');
    if(segments.length<3)continue;
    const host=segments[0]!;
    if(!(host.includes('.')||host.includes(':')||host==='localhost'))continue;
    const last=segments[segments.length-1]!;
    const separator=last.lastIndexOf(':');
    if(separator<=0)continue;
    return {registry:segments.slice(0,-1).join('/'),repository:last.slice(0,separator)};
  }
  return null;
}
/** One display name per image: the shortest unique short tag, registry-free. */
export function imageDisplayName(tags:string[],id:string):string{
  const shorts=[...new Set(tags.map(shortImageRef))].sort((a,b)=>a.length-b.length);
  return shorts[0]||id.slice(7,19);
}
export function imageOptionLabel(tags:string[],id:string,architecture?:string,hostArch?:string):string{
  const name=imageDisplayName(tags,id);
  const arch=architecture?` [${architecture}]`:'';
  const foreign=architecture&&hostArch&&architecture!==hostArch?' · 不可在本机运行':'';
  return `${name}${arch}${foreign}`;
}
export function hostFirst<T extends{architecture?:string}>(images:T[],hostArch?:string):T[]{
  return [...images].sort((a,b)=>{
    const af=a.architecture&&hostArch&&a.architecture!==hostArch?1:0;
    const bf=b.architecture&&hostArch&&b.architecture!==hostArch?1:0;
    return af-bf;
  });
}
