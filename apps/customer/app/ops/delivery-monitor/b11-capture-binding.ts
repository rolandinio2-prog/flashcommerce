type Capture = {observe:(kind:string, client?:object, channel?:object)=>void; Transport:typeof WebSocket};
export function takeB11Capture(): Capture | undefined {
 const host=globalThis as typeof globalThis & {__flashB11CaptureV1?:{take:(tag:string)=>Capture}};
 return host.__flashB11CaptureV1?.take('9C95682F08B2A93CFF148811A226B69DEF0D3CCF9B5890B6A4E15C6FA174D2C0');
}
