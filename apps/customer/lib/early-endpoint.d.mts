export function install(
 windowValue: Window | undefined,
 env: {NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTICS?:string;NEXT_PUBLIC_FLASH_STAFF_DIAGNOSTIC_BUILD?:string},
 diagnostic: typeof import('./staff-me-diagnostic')
):void;
export const version:string;
